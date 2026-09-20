import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { UpdateNotice } from '@warden/shared';
import { dataDir } from './state.js';

const PACKAGE = '@xbghc/warden';
const LATEST_URL = 'https://registry.npmjs.org/@xbghc%2fwarden/latest';
const FETCH_TIMEOUT_MS = 3000;
/** One warden is started per project, often several in a row; the registry is asked once a day, not once each. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CheckCache {
  checkedAt: number;
  latest: string;
}

export interface UpdateCheckOptions {
  current: string;
  /** Started through npx, whose cache keeps serving the old copy until `@latest` is asked for. */
  npx: boolean;
  cacheFile?: string;
  now?: () => number;
  /** Overrides the registry request; tests inject one instead of going to the network. */
  fetchLatest?: () => Promise<string>;
}

export function updateCacheFile(baseDir = dataDir()): string {
  return path.join(baseDir, 'update-check.json');
}

/** `NO_UPDATE_NOTIFIER` is the switch most npm CLIs already honour, so whoever set it meant this too. */
export function updateCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.WARDEN_NO_UPDATE_CHECK && !env.NO_UPDATE_NOTIFIER && !env.CI;
}

/** Plain `X.Y.Z` only, which is all warden publishes; anything else compares as not newer rather than guessing. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

async function fetchLatestFromRegistry(): Promise<string> {
  const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string') throw new Error('registry answer carries no version');
  return body.version;
}

async function readCache(file: string, now: number): Promise<string | undefined> {
  try {
    const cache = JSON.parse(await readFile(file, 'utf8')) as Partial<CheckCache>;
    if (typeof cache.latest !== 'string' || typeof cache.checkedAt !== 'number') return undefined;
    // A timestamp from the future is a clock that was moved, not a fresh answer.
    const age = now - cache.checkedAt;
    return age >= 0 && age < CHECK_INTERVAL_MS ? cache.latest : undefined;
  } catch {
    return undefined;
  }
}

/** An unwritable data directory costs a request on the next start; it does not cost this answer. */
async function writeCache(file: string, cache: CheckCache): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache));
  } catch {
    /* asked again next time */
  }
}

/**
 * Whether the registry has a release newer than `current`. Never rejects: being offline, or behind
 * a proxy Node does not know about, must not get in the way of a review, so every failure reads as
 * "nothing to report". A failed request is not cached and the next start asks again.
 */
export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateNotice | null> {
  try {
    const cacheFile = opts.cacheFile ?? updateCacheFile();
    const now = (opts.now ?? Date.now)();
    let latest = await readCache(cacheFile, now);
    if (latest === undefined) {
      latest = await (opts.fetchLatest ?? fetchLatestFromRegistry)();
      await writeCache(cacheFile, { checkedAt: now, latest });
    }
    if (!isNewer(latest, opts.current)) return null;
    const command = opts.npx ? `npx ${PACKAGE}@latest` : `npm i -g ${PACKAGE}@latest`;
    return { current: opts.current, latest, command };
  } catch {
    return null;
  }
}
