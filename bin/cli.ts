import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkForUpdate, startServer, updateCheckEnabled } from '@warden/server';

declare const __WARDEN_VERSION__: string | undefined;
const VERSION = typeof __WARDEN_VERSION__ !== 'undefined' ? __WARDEN_VERSION__ : 'dev';

interface CliArgs {
  repoPath: string;
  port?: number;
  open: boolean;
  updateCheck: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repoPath: process.cwd(), open: true, updateCheck: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--no-open') args.open = false;
    else if (a === '--open') args.open = true;
    else if (a === '--no-update-check') args.updateCheck = false;
    else if (a === '--port' || a === '-p') {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v)) throw new Error('--port requires a number');
      args.port = Number(v);
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      if (!/^\d+$/.test(v)) throw new Error('--port requires a number');
      args.port = Number(v);
    } else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else args.repoPath = path.resolve(a);
  }
  return args;
}

function usage(): string {
  return `warden — local git diff review UI

Usage: warden [repoPath] [options]

Options:
  --port <n>, -p <n>   Listen on a fixed port (default: first free port from 4100, and under WSL
                       the first one the Windows side can reach)
  --no-open            Do not try to open the browser
  --no-update-check    Do not ask the npm registry whether a newer warden exists
                       (also: WARDEN_NO_UPDATE_CHECK=1, NO_UPDATE_NOTIFIER=1, CI)
  -h, --help           Show this help
  -v, --version        Print version
`;
}

/** Try wslview, explorer.exe, xdg-open in order; silently give up if none works. */
async function openBrowser(url: string): Promise<boolean> {
  const candidates: [string, string[]][] = [
    ['wslview', [url]],
    ['explorer.exe', [url]],
    ['xdg-open', [url]],
  ];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      } catch {
        resolve(false);
        return;
      }
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}

function resolveWebDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WARDEN_WEB_DIR,
    path.join(here, 'web'), // dist/cli.js -> dist/web
    path.join(here, '..', 'dist', 'web'), // bin/cli.ts (tsx dev) -> dist/web
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const webDir = resolveWebDir();
  if (!webDir) {
    console.error('warning: built web assets not found (dist/web). Only the /api endpoints will be served.');
  }

  // Started before the server so the two overlap, and never awaited on the way to a usable page:
  // the answer is printed whenever it lands, and the page asks for it on its own. A dev run has no
  // version to compare. npx unpacks into a `_npx` cache directory, which is how that case is told
  // from a global install and given the command that actually refreshes it.
  const viaNpx = fileURLToPath(import.meta.url).includes(`${path.sep}_npx${path.sep}`);
  const checking = args.updateCheck && VERSION !== 'dev' && updateCheckEnabled();
  const update = checking ? checkForUpdate({ current: VERSION, npx: viaNpx }) : Promise.resolve(null);

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ repoPath: args.repoPath, port: args.port, webDir, update });
  } catch (e) {
    console.error(`warden: ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`warden ${VERSION}`);
  console.log(`  repo:  ${server.repo.root}`);
  console.log(`  state: ${server.stateFile}`);
  console.log(`  url:   ${server.url}`);
  if (server.skippedPorts.length > 0) {
    const ports = server.skippedPorts.join(', ');
    const plural = server.skippedPorts.length > 1 ? 's' : '';
    console.log(`  note:  skipped port${plural} ${ports} — the WSL2 localhost relay does not publish ${plural ? 'them' : 'it'} to Windows`);
  }
  if (server.windowsReachable === false) {
    console.error(`warning: Windows cannot reach ${server.url} either. Run with --port <n> to pick a port it can publish.`);
  }
  if (args.open) {
    const opened = await openBrowser(server.url);
    if (!opened) console.log('  (could not open a browser automatically; open the URL manually)');
  }
  void update.then((u) => {
    if (u) console.log(`  update: ${u.latest} is available (running ${u.current}) — ${u.command}`);
  });

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
