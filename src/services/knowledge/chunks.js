import { RAG_CONFIG } from '../../config/rag.js';

const COMMON_MANUAL_HEADINGS =
  /^(intended use|important instructions|read\s*&?\s*save|usage|operation|fan operation|installation|assembly|setup|getting started|controls?|control features|remote control|cleaning|care and cleaning|care and maintenance|maintenance|repair|storage|fuse replacement|troubleshooting|frequently asked questions|specifications?|technical specifications?|warranty|limited warranty|customer assistance|customer service|how to obtain warranty service|returns?|refunds?|parts?|contents?|features?|auto-off feature|washing instructions|hang to dry)\s*(?:(:)\s*(.+))?$/i;

function normalizeSectionTitle(title, fallback) {
  return String(title || fallback || 'Document')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[:\s]+$/, '')
    .trim();
}

/**
 * Recognize document headings and their existing section-level metadata.
 * @param {string} line - One document or customer-reply line.
 * @returns {Object|null} Heading details, or null for an ordinary content line.
 */
function headingDetails(line) {
  const value = String(line || '').trim();
  // Pipes are normally extracted table columns, not headings. Treating a row
  // such as "Part | Period" as a heading would separate it from its values.
  if (!value || value.length > 150 || value.includes('|')) {
    return null;
  }

  const markdown = value.match(/^#{1,6}\s+(.+)$/);
  if (markdown) {
    return {
      number: null,
      title: normalizeSectionTitle(markdown[1], 'Document')
    };
  }

  const numbered = value.match(/^SECTION\s+(\d+)\.?\s+(.+?)\s*$/i);
  if (numbered) {
    return {
      number: Number.parseInt(numbered[1], 10),
      title: normalizeSectionTitle(numbered[2], value)
    };
  }

  const commonHeading = value.match(COMMON_MANUAL_HEADINGS);
  if (commonHeading) {
    return {
      number: null,
      title: normalizeSectionTitle(commonHeading[1], 'Document'),
      inlineBody: commonHeading[2] ? commonHeading[3]?.trim() || null : null
    };
  }

  const letters = value.replace(/[^\p{L}]/gu, '');
  const wordCount = value.split(/\s+/).length;
  const upperCaseHeading = letters.length >= 4 && wordCount <= 14 && letters === letters.toLocaleUpperCase() && !/[.!?]$/.test(value);

  return upperCaseHeading ? { number: null, title: normalizeSectionTitle(value, 'Document') } : null;
}

/**
 * Group document lines into heading-based sections while preserving section content.
 * @param {string} text - Text to normalize or inspect.
 * @param {Object} options - Options: pageNumber.
 * @returns {Array<Object>} Ordered document sections.
 */
function splitLinesIntoSections(text, { pageNumber = null } = {}) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let current = {
    sectionNumber: null,
    sectionTitle: 'Document information',
    lines: []
  };

  const flush = () => {
    const content = current.lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (content) {
      sections.push({
        sectionNumber: current.sectionNumber,
        sectionTitle: current.sectionTitle,
        pageStart: pageNumber,
        pageEnd: pageNumber,
        content
      });
    }
  };

  for (const line of lines) {
    const heading = headingDetails(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    flush();
    current = {
      sectionNumber: heading.number,
      sectionTitle: heading.title,
      // Retaining the visible heading improves embeddings and keeps the chunk
      // understandable if it is inspected without surrounding chunks.
      lines: [heading.title, heading.inlineBody].filter(Boolean)
    };
  }
  flush();

  return mergeSmallSections(sections);
}

function sectionWordCount(section) {
  return String(section?.content || '').match(/\S+/g)?.length || 0;
}

/**
 * Merge short adjacent sections using the existing chunk-size rules.
 * @param {Array<Object>} sections - Parsed document sections.
 * @param {number} minimumWords - Minimum section size before merging adjacent text.
 * @returns {Array<Object>} Sections prepared for chunking without discarding content.
 */
function mergeSmallSections(sections, minimumWords = 80) {
  const merged = [];
  let pending = null;
  for (const section of sections) {
    if (!pending) {
      pending = { ...section };
      continue;
    }
    if (sectionWordCount(pending) < minimumWords) {
      pending = {
        ...pending,
        sectionNumber: section.sectionNumber ?? pending.sectionNumber,
        sectionTitle: section.sectionTitle || pending.sectionTitle,
        content: `${pending.content}\n${section.content}`.trim()
      };
      continue;
    }
    merged.push(pending);
    pending = { ...section };
  }
  if (pending) {
    if (merged.length && sectionWordCount(pending) < minimumWords) {
      const previous = merged[merged.length - 1];
      merged[merged.length - 1] = {
        ...previous,
        content: `${previous.content}\n${pending.content}`.trim()
      };
    } else {
      merged.push(pending);
    }
  }

  return merged;
}

/**
 * Choose the existing section splitting method for extracted document text.
 * @param {string} text - Text to normalize or inspect.
 * @returns {Array<Object>} Normalized sections used by document chunking.
 */
function splitIntoSections(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }
  const sections = splitLinesIntoSections(normalized);

  return sections.length
    ? sections
    : [
        {
          sectionNumber: null,
          sectionTitle: 'Document',
          pageStart: null,
          pageEnd: null,
          content: normalized
        }
      ];
}

/**
 * Use supplied document or page sections, falling back to text-derived sections.
 * @param {Object} options - Options: text, sections, pages.
 * @returns {Array<Object>} Document sections with the existing titles and page information.
 */
function resolveDocumentSections({ text, sections, pages }) {
  if (Array.isArray(sections) && sections.length > 0) {
    return sections
      .map((section, index) => ({
        sectionNumber: section.sectionNumber ?? index + 1,
        sectionTitle: normalizeSectionTitle(section.sectionTitle || section.title, `Section ${index + 1}`),
        pageStart: section.pageStart ?? section.pageNumber ?? null,
        pageEnd: section.pageEnd ?? section.pageNumber ?? null,
        content: String(section.content || '').trim()
      }))
      .filter(section => section.content);
  }

  if (Array.isArray(pages) && pages.length > 0) {
    return pages.flatMap(page => {
      const pageSections = splitLinesIntoSections(page.content, {
        pageNumber: page.pageNumber
      });

      return pageSections.length
        ? pageSections
        : [
            {
              sectionNumber: null,
              sectionTitle: `Page ${page.pageNumber}`,
              pageStart: page.pageNumber,
              pageEnd: page.pageNumber,
              content: page.content
            }
          ];
    });
  }

  return splitIntoSections(text);
}

/**
 * Split a section into overlapping text chunks using the configured size limits.
 * @param {Object} section - One document section and its metadata.
 * @param {number} wordsPerChunk - Target word count for each chunk.
 * @param {number} overlapWords - Words shared with the following chunk.
 * @returns {Array<Object>} Chunks retaining their section metadata.
 */
function chunkSection(section, wordsPerChunk, overlapWords) {
  const words = [...section.content.matchAll(/\S+/g)];
  if (words.length === 0) {
    return [];
  }

  const size = Math.max(80, wordsPerChunk);
  const overlap = Math.min(Math.max(0, overlapWords), size - 1);
  const step = size - overlap;
  const chunks = [];

  for (let start = 0; start < words.length; start += step) {
    const last = words[Math.min(start + size, words.length) - 1];
    const body = section.content.slice(words[start].index, last.index + last[0].length).trim();
    chunks.push({
      sectionNumber: section.sectionNumber,
      sectionTitle: section.sectionTitle,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      content: body
    });
    if (start + size >= words.length) {
      break;
    }
  }

  return chunks;
}

function pageLabel(chunk) {
  if (!Number.isInteger(chunk.pageStart)) {
    return null;
  }

  return chunk.pageStart === chunk.pageEnd || !Number.isInteger(chunk.pageEnd)
    ? `Page: ${chunk.pageStart}`
    : `Pages: ${chunk.pageStart}-${chunk.pageEnd}`;
}

function resolveApplicableProducts(document) {
  if (Array.isArray(document.products) && document.products.length) {
    return document.products;
  }

  return document.product?.productId ? [document.product] : [];
}

function uniqueProductValues(products, field) {
  return [...new Set(products.map(product => product[field]).filter(Boolean))];
}

function uniqueNestedProductValues(products, field) {
  return [...new Set(products.flatMap(product => product[field] || []).filter(Boolean))];
}

/**
 * Turn a parsed document into bounded, overlapping knowledge chunks with stable metadata.
 * @param {Object} options - Options: text, sections, pages, title, product, products, documentScope, documentType.
 * @returns {Array<Object>} Chunks ready for embedding and persistence.
 */
export function chunkDocument({ text, sections, pages, title, product, products, documentScope, documentType }) {
  const applicableProducts = resolveApplicableProducts({ product, products });
  const productIds = uniqueProductValues(applicableProducts, 'productId');
  const productNames = uniqueProductValues(applicableProducts, 'productName');
  const manufacturerBrands = uniqueProductValues(applicableProducts, 'manufacturerBrand');
  const alternateProductIds = uniqueNestedProductValues(applicableProducts, 'alternateProductIds');
  const modelIds = uniqueNestedProductValues(applicableProducts, 'modelIds');
  const resolvedSections = resolveDocumentSections({ text, sections, pages });

  const chunks = resolvedSections.flatMap(section =>
    chunkSection(section, RAG_CONFIG.chunking.wordsPerChunk, RAG_CONFIG.chunking.overlapWords)
  );

  return chunks.map(chunk => {
    const prefix = [
      title && `Document: ${title}`,
      documentType && `Document type: ${documentType}`,
      documentScope && `Scope: ${documentScope}`,
      manufacturerBrands.length && `Manufacturer brand${manufacturerBrands.length > 1 ? 's' : ''}: ${manufacturerBrands.join(', ')}`,
      productNames.length && `Product${productNames.length > 1 ? 's covered' : ''}: ${productNames.join(' / ')}`,
      productIds.length && `Product ID${productIds.length > 1 ? 's' : ''}: ${productIds.join(', ')}`,
      alternateProductIds.length && `Alternate item numbers: ${alternateProductIds.join(', ')}`,
      modelIds.length && `Model numbers: ${modelIds.join(', ')}`,
      pageLabel(chunk),
      chunk.sectionTitle && `Section: ${chunk.sectionTitle}`
    ]
      .filter(Boolean)
      .join('\n');

    return { ...chunk, content: `${prefix}\n\n${chunk.content}`.trim() };
  });
}
