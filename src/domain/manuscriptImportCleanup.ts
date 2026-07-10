export type ManuscriptImportCleanupOptions = {
  addExtraSpacingBetweenLines: boolean;
};

export function normalizeManuscriptLineEndings(text: string) {
  return text.replace(/\r\n?|\u2028|\u2029/g, '\n');
}

export function cleanupImportedManuscriptText(
  text: string,
  options: ManuscriptImportCleanupOptions
) {
  const normalized = normalizeManuscriptLineEndings(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();

  if (!normalized || !options.addExtraSpacingBetweenLines) return normalized;

  // Canonicalize every existing line break to one blank line. Collapsing the
  // whole break run makes this safe to apply again to restored/imported text.
  return normalized.replace(/\n(?:[ \t]*\n)*/g, '\n\n');
}
