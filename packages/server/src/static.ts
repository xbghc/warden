import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { Context } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Minimal SPA static handler with path-traversal protection and index.html fallback. */
export async function serveStaticFile(c: Context, webDir: string): Promise<Response> {
  const root = path.resolve(webDir);
  let rel: string;
  try {
    rel = decodeURIComponent(c.req.path);
  } catch {
    return c.text('Bad Request', 400);
  }
  let target = path.resolve(root, '.' + rel);
  if (target !== root && !target.startsWith(root + path.sep)) return c.text('Forbidden', 403);
  try {
    const st = await stat(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
  } catch {
    target = path.join(root, 'index.html');
  }
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return c.text('Not Found', 404);
  }
  const ext = path.extname(target).toLowerCase();
  const isAsset = rel.startsWith('/assets/');
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}
