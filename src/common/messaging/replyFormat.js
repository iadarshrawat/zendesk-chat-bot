// Presentation only, after evidence validation. No LLM call, truncation,
// renumbering, fact generation or changes to internal pending-case text.
function highlightItemLabel(body) {
  if (body.startsWith('**') || /`/.test(body)) {
    return body;
  }

  const label = body.match(/^([^*\n]{2,160}?)(\s+[–—-]\s+|:\s+)(.+)$/);

  return label ? `**${label[1]}**${label[2]}${label[3]}` : body;
}

/**
 * Normalize customer-facing list and heading syntax without changing answer content.
 * @param {string} line - One document or customer-reply line.
 * @returns {string} The formatted line used by the reply formatter.
 */
function normalizeLine(line) {
  // Inline code may contain punctuation that looks like headings or list syntax.
  if (/`/.test(line)) {
    return line;
  }

  const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+)$/);
  if (heading) {
    const title = heading[1].replace(/[ \t]+#+[ \t]*$/, '').trim();

    return title.startsWith('**') && title.endsWith('**') ? title : `**${title}**`;
  }

  const item = line.match(/^([ \t]*)([-*+]|[0-9]{1,3}[.)])[ \t]+(.+)$/);
  if (item) {
    const marker = /^\d/.test(item[2]) ? item[2] : '-';

    return `${item[1]}${marker} ${highlightItemLabel(item[3])}`;
  }

  // A short existing section label is emphasized, not invented or reworded.
  if (/^\S.{0,78}:$/.test(line) && !line.startsWith('**')) {
    return `**${line}**`;
  }

  return line;
}

function isHeading(line) {
  return /^\*\*.+\*\*$/.test(line);
}

function isTopLevelListItem(line) {
  return /^(?:[-*+]|\d+[.)])[ \t]+/.test(line);
}

function shouldSeparateLines(previousLine, currentLine) {
  return (
    isHeading(currentLine) ||
    isHeading(previousLine) ||
    isTopLevelListItem(currentLine) ||
    (isTopLevelListItem(previousLine) && !/^[ \t]/.test(currentLine))
  );
}

/**
 * Format the generated customer text using the paragraph, list, and heading rules.
 * @param {*} reply - Generated reply text; non-string values pass through unchanged.
 * @returns {string} The message text ready for Sunshine delivery.
 */
export function formatCustomerReply(reply) {
  if (typeof reply !== 'string') {
    return reply;
  }

  const output = [];
  let openFence = null;
  const lines = reply.replace(/\r\n?/g, '\n').split('\n');

  for (const rawLine of lines) {
    const fenceMarker = rawLine.match(/^ {0,3}(`{3,}|~{3,})/);
    if (openFence || fenceMarker) {
      output.push(rawLine);

      if (!openFence) {
        openFence = { char: fenceMarker[1][0], length: fenceMarker[1].length };
      } else {
        const closesCurrentFence =
          fenceMarker &&
          fenceMarker[1][0] === openFence.char &&
          fenceMarker[1].length >= openFence.length &&
          !rawLine.slice(fenceMarker[0].length).trim();

        if (closesCurrentFence) {
          openFence = null;
        }
      }

      continue;
    }

    if (/^(?: {4}|\t)/.test(rawLine)) {
      output.push(rawLine);
      continue;
    }

    const indent = rawLine.match(/^[ \t]*/)[0];
    // Split explicit inline bullet separators, not numeric ranges, hyphens,
    // decimal points or a single literal multiplication/interpunct expression.
    const bulletCount = (rawLine.match(/[•▪]/g) || []).length;
    const containsInlineList =
      bulletCount > 1 && !/`/.test(rawLine) && (/^[ \t]*[•▪][ \t]+/.test(rawLine) || /[.!?:)][ \t]+[•▪][ \t]+/.test(rawLine));
    const expandedLine = containsInlineList
      ? rawLine.replace(/[ \t]*[•▪][ \t]+/g, `\n\n${indent}- `)
      : rawLine.replace(/^([ \t]*)[•▪·][ \t]+/, '$1- ');

    for (const part of expandedLine.split('\n')) {
      const line = normalizeLine(part.replace(/[ \t]+$/, ''));
      const previousLine = output.at(-1);

      if (!line && previousLine === '') {
        continue;
      }
      if (line && previousLine && shouldSeparateLines(previousLine, line)) {
        output.push('');
      }

      output.push(line);
    }
  }

  return output
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}
