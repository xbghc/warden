import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

export interface Token {
  content: string;
  color?: string;
}

const THEME = 'github-light';

type LangModule = { default: LanguageRegistration[] };

/**
 * Curated grammar set (each is a lazily loaded chunk). Add an entry here to support another
 * language; anything not listed renders as plain text.
 */
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  json5: () => import('@shikijs/langs/json5'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  html: () => import('@shikijs/langs/html'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  makefile: () => import('@shikijs/langs/makefile'),
  lua: () => import('@shikijs/langs/lua'),
  swift: () => import('@shikijs/langs/swift'),
  dart: () => import('@shikijs/langs/dart'),
  diff: () => import('@shikijs/langs/diff'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  prisma: () => import('@shikijs/langs/prisma'),
  nginx: () => import('@shikijs/langs/nginx'),
};

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  swift: 'swift',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  env: 'dotenv',
  prisma: 'prisma',
};

const NAME_TO_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.env': 'dotenv',
  'nginx.conf': 'nginx',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.babelrc': 'json',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
};

/** Resolve a language id for a path; null when unknown (plain text). */
export function langForPath(filePath: string): string | null {
  const name = (filePath.split('/').pop() ?? '').toLowerCase();
  const byName = NAME_TO_LANG[name];
  if (byName) return byName;
  if (name.startsWith('.env.')) return 'dotenv';
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const lang = EXT_TO_LANG[name.slice(dot + 1)];
  return lang && LANG_LOADERS[lang] ? lang : null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-light')],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();

async function ensureLang(h: HighlighterCore, lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  let p = loading.get(lang);
  if (!p) {
    const loader = LANG_LOADERS[lang];
    if (!loader) return false;
    p = loader()
      .then(async (m) => {
        await h.loadLanguage(...m.default);
        loaded.add(lang);
        return true;
      })
      .catch(() => false)
      .finally(() => loading.delete(lang));
    loading.set(lang, p);
  }
  return p;
}

/** Tokenize lines: returns exactly one token list per input line, or null when the language is unavailable. */
export async function tokenizeLines(lang: string, lines: string[]): Promise<Token[][] | null> {
  if (lines.length === 0) return [];
  const h = await getHighlighter();
  if (!(await ensureLang(h, lang))) return null;
  const code = lines.join('\n');
  const result = h.codeToTokensBase(code, { lang, theme: THEME, includeExplanation: false });
  const out: Token[][] = result.map((line) => line.map((t) => ({ content: t.content, color: t.color })));
  while (out.length < lines.length) out.push([{ content: lines[out.length] ?? '' }]);
  return out.slice(0, lines.length);
}
