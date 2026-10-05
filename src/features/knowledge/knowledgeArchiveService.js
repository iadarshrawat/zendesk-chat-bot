import path from "node:path";
import os from "node:os";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";

const MAX_ARCHIVE_BYTES = 750 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1_536 * 1024 * 1024;
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 5_000;

function megabytes(bytes) {
  return bytes / 1024 / 1024;
}

export function isIgnoredKnowledgePath(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((part) =>
    part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._") || part.startsWith("."),
  );
}

function safeArchivePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").normalize("NFKC");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/")
    || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`Unsafe ZIP entry path: ${value}`);
  }

  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${value}`);
  }
  return parts.join("/");
}

async function resolvePackageRoot(extractedRoot) {
  const entries = (await readdir(extractedRoot, { withFileTypes: true }))
    .filter((entry) => !isIgnoredKnowledgePath(entry.name));
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "products.json")) {
    return extractedRoot;
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || entries.some((entry) => entry.isFile())) return extractedRoot;

  const nested = path.join(extractedRoot, directories[0].name);
  const nestedEntries = await readdir(nested, { withFileTypes: true });
  return nestedEntries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "products.json")
    ? nested
    : extractedRoot;
}

async function extractKnowledgeZip(archivePath) {
  const archiveStat = await stat(archivePath);
  if (archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`Knowledge ZIP exceeds the ${megabytes(MAX_ARCHIVE_BYTES)} MB compressed limit`);
  }

  // A streaming ZIP parser can wait forever for the next record when an
  // upload is truncated. Check for the mandatory end record before opening
  // the archive so incomplete uploads fail clearly and promptly.
  const handle = await open(archivePath, "r");
  try {
    const tailLength = Math.min(archiveStat.size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, archiveStat.size - tailLength);
    if (tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < 0) {
      throw new Error("Knowledge ZIP is incomplete or invalid: end-of-central-directory record not found");
    }
  } finally {
    await handle.close();
  }

  const directory = await unzipper.Open.file(archivePath);
  if (directory.files.length > MAX_ENTRIES) {
    throw new Error(`Knowledge ZIP contains more than ${MAX_ENTRIES} entries`);
  }

  const extractionRoot = await mkdtemp(path.join(os.tmpdir(), "zendesk-rag-"));
  let entryCount = 0;
  let extractedBytes = 0;
  const seenPaths = new Set();
  try {
    for (const entry of directory.files) {
      const relativePath = safeArchivePath(entry.path);
      if (isIgnoredKnowledgePath(relativePath)) continue;
      entryCount += 1;
      if (seenPaths.has(relativePath)) {
        throw new Error(`Knowledge ZIP contains a duplicate path: ${relativePath}`);
      }
      seenPaths.add(relativePath);

      const destination = path.resolve(extractionRoot, relativePath);
      if (destination !== extractionRoot && !destination.startsWith(`${extractionRoot}${path.sep}`)) {
        throw new Error(`Unsafe ZIP entry path: ${entry.path}`);
      }
      if (entry.type === "Directory") {
        await mkdir(destination, { recursive: true });
        continue;
      }
      if (entry.type !== "File") {
        throw new Error(`Unsupported ZIP entry type for ${entry.path}`);
      }

      const declaredSize = Number(entry.uncompressedSize ?? entry.vars?.uncompressedSize) || 0;
      if (declaredSize > MAX_ENTRY_BYTES) {
        throw new Error(`ZIP entry exceeds the ${megabytes(MAX_ENTRY_BYTES)} MB limit: ${entry.path}`);
      }
      if (extractedBytes + declaredSize > MAX_EXTRACTED_BYTES) {
        throw new Error(`Knowledge ZIP exceeds the ${megabytes(MAX_EXTRACTED_BYTES)} MB extracted limit`);
      }

      await mkdir(path.dirname(destination), { recursive: true });
      let entryBytes = 0;
      const byteLimit = new Transform({
        transform(chunk, _encoding, callback) {
          entryBytes += chunk.length;
          extractedBytes += chunk.length;
          if (entryBytes > MAX_ENTRY_BYTES || extractedBytes > MAX_EXTRACTED_BYTES) {
            callback(new Error(`Knowledge ZIP exceeds safe extraction limits at ${entry.path}`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(entry.stream(), byteLimit, createWriteStream(destination, { flags: "wx" }));
    }

    const cleanup = () => rm(extractionRoot, { recursive: true, force: true });
    return {
      rootPath: await resolvePackageRoot(extractionRoot),
      cleanup,
      extracted: true,
      entryCount,
      extractedBytes,
    };
  } catch (error) {
    try {
      await rm(extractionRoot, { recursive: true, force: true });
    } catch {
      // Preserve the extraction failure; cleanup is best effort on this path.
    }
    throw error;
  }
}

export async function prepareKnowledgeSource(sourcePath) {
  const resolved = path.resolve(sourcePath);
  const sourceStat = await stat(resolved);
  if (sourceStat.isDirectory()) {
    return { rootPath: resolved, cleanup: async () => {}, extracted: false };
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Knowledge source is not a file or directory: ${resolved}`);
  }
  if (path.extname(resolved).toLowerCase() !== ".zip") {
    return { rootPath: resolved, cleanup: async () => {}, extracted: false };
  }
  return extractKnowledgeZip(resolved);
}
