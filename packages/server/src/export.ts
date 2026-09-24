import type { Comment, Issue } from '@warden/shared';

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'md',
  mdx: 'mdx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  lua: 'lua',
  swift: 'swift',
  dart: 'dart',
};

export function langForPath(filePath: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath);
  if (!m?.[1]) return '';
  return LANG_BY_EXT[m[1].toLowerCase()] ?? m[1].toLowerCase();
}

/** How a comment is named to the agent, and what `warden reply` takes: enough of the id to be unique in practice. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

const quote = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');

function formatCommentSection(c: Comment): string {
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  const width = String(c.endLine).length;
  const code = c.codeSnippet.map((line, i) => `${String(c.startLine + i).padStart(width, ' ')} | ${line}`).join('\n');
  const lang = langForPath(c.filePath);
  const fence = code.includes('```') ? '````' : '```';
  const orphanNote = c.status === 'orphaned' ? ' [orphaned: original location no longer exists]' : '';
  const parts = [`## ${c.filePath}:${range} (${c.side}) [id: ${shortId(c.id)}]${orphanNote}`, `${fence}${lang}`, code, fence, quote(c.body)];
  // A follow-up only makes sense with what was said before it, so the thread goes out whole.
  for (const r of c.replies ?? []) parts.push(`${r.author === 'agent' ? 'Agent' : 'Reviewer'} replied:\n${quote(r.body)}`);
  return parts.join('\n');
}

export interface ExportOptions {
  repoRoot: string;
  comments: Comment[];
  /**
   * How the agent reaches `warden reply` (`warden`, or `npx @xbghc/warden` for an npx run). When
   * given, the export ends with a line telling the agent to answer each comment that way, so a
   * prompt pasted into any agent carries its own instructions.
   */
  replyCommand?: string;
}

export function replyFooter(replyCommand: string): string {
  return `When you have dealt with a comment, answer it with \`${replyCommand} reply <id> "<what you changed, or why you did not>"\` so the reviewer sees your answer beside it.`;
}

/** Agent-readable export of comments (see spec 3.5). */
export function formatCommentsExport({ repoRoot, comments, replyCommand }: ExportOptions): string {
  const targets = [...new Set(comments.map((c) => c.targetKey))];
  const head = ['# Review comments', `Target: ${targets.join(', ') || '-'}`, `Repo: ${repoRoot}`, `Count: ${comments.length}`];
  const sections = comments.map(formatCommentSection);
  const tail = replyCommand && comments.length > 0 ? [replyFooter(replyCommand)] : [];
  return [head.join('\n'), ...sections, ...tail].join('\n\n') + '\n';
}

export interface IssueExportOptions {
  repoRoot: string;
  issue: Issue;
  comments: Comment[];
  replyCommand?: string;
}

export function formatIssueExport({ repoRoot, issue, comments, replyCommand }: IssueExportOptions): string {
  const targets = [...new Set(comments.map((c) => c.targetKey))];
  const head = [`# Issue: ${issue.title}`, `Status: ${issue.status}`, `Target: ${targets.join(', ') || '-'}`, `Repo: ${repoRoot}`, `Count: ${comments.length}`];
  const parts = [head.join('\n')];
  if (issue.body.trim()) parts.push(issue.body.trim());
  parts.push(...comments.map(formatCommentSection));
  if (replyCommand && comments.length > 0) parts.push(replyFooter(replyCommand));
  return parts.join('\n\n') + '\n';
}
