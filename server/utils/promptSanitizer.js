function safe(value) {
  return value === undefined || value === null ? '' : value;
}

function sanitizePlainTextSegment(segment) {
  if (!segment) return '';

  let cleaned = segment.replace(/(^|[\s([{"'“”‘’])(?:undefined|null)(?=($|[\s)\]}:;,.!?"'“”‘’]))/g, '$1');

  cleaned = cleaned
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([({\[])[ \t]+/g, '$1')
    .replace(/[ \t]+([)}\]])/g, '$1')
    .replace(/ {2,}/g, ' ');

  return cleaned;
}

function sanitizeGeneratedText(text) {
  if (text === undefined || text === null) return '';
  const input = typeof text === 'string' ? text : String(text);

  if (!/\b(?:undefined|null)\b/.test(input)) {
    return input;
  }

  const segments = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const sanitized = segments
    .map((segment) => {
      if (!segment) return segment;
      if (segment.startsWith('```') || (segment.startsWith('`') && segment.endsWith('`'))) {
        return segment;
      }
      return sanitizePlainTextSegment(segment);
    })
    .join('');

  return sanitized.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  safe,
  sanitizeGeneratedText
};
