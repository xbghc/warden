import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The demo's development server: static files from the directory it is started in.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const port = Number(process.env.PORT ?? 4173);
createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
  const file = path.join(process.cwd(), path.normalize(name));
  try {
    if (!file.startsWith(process.cwd() + path.sep)) throw new Error('outside');
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'text/plain', 'cache-control': 'no-store' });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Orders demo on http://127.0.0.1:${port}`));
