import path from 'node:path';
import { ingestKnowledgePath } from '../src/services/knowledge/index.js';
import { prepareKnowledgeSource } from '../src/services/knowledge/archives.js';
import { ensureKnowledgeContainer } from '../src/loaders/database/cosmos.js';

const BOOLEAN_FLAGS = new Set(['validate-only', 'allow-missing-manuals']);

/**
 * Parse the knowledge-ingestion CLI flags and reject unsupported arguments.
 * @param {Array<string>} argv - Command-line arguments after the script name.
 * @returns {Object} The ingestion options selected by the operator.
 */
function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      continue;
    }

    const key = argument.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }

    options[key] = value;
    index += 1;
  }

  return options;
}

/**
 * Print the existing supported ingestion arguments and usage examples.
 * @returns {void} Writes the CLI usage text.
 */
function printHelp() {
  console.log(`Usage:
  npm run ingest -- --source <brand-folder-or-zip> --brand-key <brand-key>

Supported brand keys:
  mr-brand
  comfort-zone

Required package structure:
  products.json       One structured product catalog
  manuals/            Product manuals; every file must resolve to one or more catalog products
  policies/           Optional brand-wide support, return, and warranty documents

Options:
  --source                 Extracted brand directory or ZIP file
  --brand-key              mr-brand or comfort-zone (--brand remains a compatibility alias)
  --validate-only          Parse and validate everything without calling Voyage or Cosmos DB
  --allow-missing-manuals  Permit catalog products that do not yet have a manual
  --help                   Show this help

Examples:
  npm run ingest -- --source ./knowledge/mrbrands.zip --brand-key mr-brand --validate-only
  npm run ingest -- --source ./knowledge/mrbrands.zip --brand-key mr-brand
  npm run ingest -- --source ./knowledge/comfort-zone.zip --brand-key comfort-zone`);
}

/**
 * Prepare the requested knowledge source, run ingestion, and clean up any extracted archive.
 * @returns {Promise<void>} Resolves after the existing ingestion command flow.
 */
async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    printHelp();

    return;
  }
  const brandKey = args['brand-key'] || args.brand;
  if (!args.source || !brandKey) {
    printHelp();
    throw new Error('Both --source and --brand-key are required');
  }

  const validateOnly = Boolean(args['validate-only']);
  const requireManuals = !args['allow-missing-manuals'];
  const prepared = await prepareKnowledgeSource(path.resolve(args.source));

  try {
    if (!validateOnly) {
      await ensureKnowledgeContainer();
    }

    const { summary, results } = await ingestKnowledgePath(prepared.rootPath, {
      brandKey,
      validateOnly,
      requireManuals
    });

    console.table(
      results.map(result => ({
        file: result.sourcePath,
        product: result.productIds?.length ? result.productIds.join(', ') : 'brand-wide',
        type: result.documentType,
        pages: result.pages || 'n/a',
        chunks: result.chunks,
        matchedBy: result.catalogMatchMethod || 'scope'
      }))
    );
    console.table([summary]);

    const completionMessage = summary.validationOnly
      ? 'Knowledge package validation completed. Nothing was uploaded.'
      : `Knowledge snapshot ${summary.ingestionId} is now active for ${summary.brandKey}.`;
    console.log(completionMessage);

    if (summary.cleanupWarning) {
      console.warn(summary.cleanupWarning);
    }
  } finally {
    await prepared.cleanup();
  }
}

await main().catch(error => {
  console.error('Knowledge ingestion failed:', error.message);
  process.exitCode = 1;
});
