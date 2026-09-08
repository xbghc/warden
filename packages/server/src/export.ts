import type { Comment, Issue, Todo } from '@warden/shared';

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
  if (!m || !m[1]) return '';
  return LANG_BY_EXT[m[1].toLowerCase()] ?? m[1].toLowerCase();
}

function formatCommentSection(c: Comment): string {
  const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  const width = String(c.endLine).length;
  const code = c.codeSnippet.map((line, i) => `${String(c.startLine + i).padStart(width, ' ')} | ${line}`).join('\n');
  const lang = langForPath(c.filePath);
  const body = c.body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
  const fence = code.includes('```') ? '````' : '```';
  const orphanNote = c.status === 'orphaned' ? ' [orphaned: original location no longer exists]' : '';
  return [`## ${c.filePath}:${range} (${c.side})${orphanNote}`, `${fence}${lang}`, code, fence, body].join('\n');
}

export interface ExportOptions {
  repoRoot: string;
  comments: Comment[];
}

/** Agent-readable export of comments (see spec 3.5). */
export function formatCommentsExport({ repoRoot, comments }: ExportOptions): string {
  const targets = [...new Set(comments.map((c) => c.targetKey))];
  const head = ['# Review comments', `Target: ${targets.join(', ') || '-'}`, `Repo: ${repoRoot}`, `Count: ${comments.length}`];
  const sections = comments.map(formatCommentSection);
  return [head.join('\n'), ...sections].join('\n\n') + '\n';
}

export interface IssueExportOptions {
  repoRoot: string;
  issue: Issue;
  comments: Comment[];
}

export function formatIssueExport({ repoRoot, issue, comments }: IssueExportOptions): string {
  const targets = [...new Set(comments.map((c) => c.targetKey))];
  const head = [
    `# Issue: ${issue.title}`,
    `Status: ${issue.status}`,
    `Target: ${targets.join(', ') || '-'}`,
    `Repo: ${repoRoot}`,
    `Count: ${comments.length}`,
  ];
  const parts = [head.join('\n')];
  if (issue.body.trim()) parts.push(issue.body.trim());
  parts.push(...comments.map(formatCommentSection));
  return parts.join('\n\n') + '\n';
}

export interface TodoExportOptions {
  repoRoot: string;
  branch: string;
  todos: Todo[];
}

/** Numbered checklist of a branch's todos, ready to paste at an agent. */
export function formatTodosExport({ repoRoot, branch, todos }: TodoExportOptions): string {
  const head = ['# TODO', `Branch: ${branch}`, `Repo: ${repoRoot}`, `Count: ${todos.length}`];
  const sections = todos.map((t, i) => {
    const title = `## ${i + 1}. ${t.title}${t.status === 'done' ? ' (done)' : ''}`;
    const body = t.body.replace(/\r\n/g, '\n').trim();
    return body ? `${title}\n${body}` : title;
  });
  return [head.join('\n'), ...sections].join('\n\n') + '\n';
}
