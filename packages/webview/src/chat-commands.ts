export function slashCommandQuery(text: string, start: number, end = start) {
  if (start !== end || start < 1 || start > text.length || !text.startsWith('/')) return;
  const whitespace = text.search(/\s/u);
  const tokenEnd = whitespace < 0 ? text.length : whitespace;
  if (start > tokenEnd) return;
  return { query: text.slice(1, start).toLowerCase(), tokenEnd };
}

/** Replace only the command token; arguments and task context remain untouched. */
export function completeSlashCommand(text: string, tokenEnd: number, name: string) {
  const prefix = `/${name}`;
  const suffix = text.slice(tokenEnd) || ' ';
  const value = prefix + suffix;
  if (value.length > 100_000) return;
  return { text: value, caret: prefix.length + (suffix.startsWith(' ') ? 1 : 0) };
}
