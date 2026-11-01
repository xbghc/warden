/** Parse display-only file references. Resolution and workspace containment belong to the host. */
export function parseFileReference(reference: string): { path: string; line?: number; column?: number } | undefined {
  if (!reference || reference.length > 16000) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(reference);
  } catch {
    return undefined;
  }
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.startsWith('//') || value.startsWith('\\\\'))
    return undefined;
  if (/^(?:command|vscode(?:-insiders)?|javascript|data|file|https?|mailto):/i.test(value)) return undefined;
  const location = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/.exec(value);
  const file = location ? value.slice(0, location.index) : value;
  if (!file || file.includes('#') || file.includes('?')) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return undefined;
  const line = location ? Number(location[1] ?? location[3]) : undefined;
  const column = location && (location[2] ?? location[4]) ? Number(location[2] ?? location[4]) : undefined;
  if ([line, column].some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 10_000_000))) return undefined;
  return { path: file, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}
