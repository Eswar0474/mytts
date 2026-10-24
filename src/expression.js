export function buildModulatedText(text, tags) {
  if (typeof text !== 'string') throw new TypeError('Text must be a string.');
  if (typeof tags !== 'string') throw new TypeError('Expression tags must be a string.');
  const formattedTags = tags
    .split(/[,\n]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => `[${tag.replace(/^\[|\]$/g, '')}]`)
    .join('');
  return formattedTags ? `${formattedTags} ${text}` : text;
}
