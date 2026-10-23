import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

export interface FixtureRepo {
  root: string;
  git: (...args: string[]) => string;
  write: (rel: string, content: string | Buffer) => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary git repository with a small history:
 *  c1: src/a.ts, src/b.ts, README.md
 *  c2: modifies src/a.ts, adds src/util/c.ts
 */
export async function makeFixtureRepo(prefix = 'warden-fixture-'): Promise<FixtureRepo> {
  // macOS exposes its temporary directory through a symlink; Git resolves it.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    HOME: root,
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  const write = async (rel: string, content: string | Buffer) => {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  };
  git('init', '-q', '-b', 'main');
  // Server-side commits do not inherit the fixture helper's identity environment.
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  await write('src/a.ts', ['export function a() {', '  return 1;', '}', ''].join('\n'));
  await write('src/b.ts', ['export const b = 2;', ''].join('\n'));
  await write('README.md', '# fixture\n');
  git('add', '.');
  git('commit', '-q', '-m', 'c1: initial');
  await write('src/a.ts', ['export function a() {', '  return 2;', '}', '', 'export const extra = true;', ''].join('\n'));
  await write('src/util/c.ts', ['export const c = 3;', ''].join('\n'));
  git('add', '.');
  git('commit', '-q', '-m', 'c2: change a, add c');
  return {
    root,
    git,
    write,
    cleanup: async () => {
      await rm(`${root}-warden`, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}
