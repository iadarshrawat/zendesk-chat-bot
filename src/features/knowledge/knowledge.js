import { createHash } from "node:crypto";

export function normalizeKnowledgeKey(value, fallback = "default") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function normalizeFilterValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeStringArray(values) {
  const input = Array.isArray(values) ? values : values ? [values] : [];
  const normalizedValues = input.map(normalizeFilterValue).filter(Boolean);
  return [...new Set(normalizedValues)];
}

export function normalizeMaterialValue(value) {
  let material = normalizeFilterValue(value);
  if (material === "aluminum") {
    material = "aluminium";
  }
  if (material.endsWith(" metal") && material !== "metal") {
    material = material.slice(0, -" metal".length).trim();
  }
  return material;
}

export function createStableId(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 40);
}
