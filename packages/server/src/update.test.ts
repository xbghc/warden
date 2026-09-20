import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_INTERVAL_MS, checkForUpdate, isNewer, updateCheckEnabled } from './update.js';

let dir: string;
let cacheFile: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'warden-update-'));
  cacheFile = path.join(dir, 'nested', 'update-check.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isNewer', () => {
  it('compares each part as a number', () => {
    expect(isNewer('0.12.0', '0.11.1')).toBe(true);
    expect(isNewer('0.11.10', '0.11.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.11.1', '0.11.1')).toBe(false);
    expect(isNewer('0.11.0', '0.11.1')).toBe(false);
  });

  it('says no to anything that is not X.Y.Z', () => {
    expect(isNewer('1.0.0-beta.1', '0.11.1')).toBe(false);
    expect(isNewer('1.0.0', 'dev')).toBe(false);
    expect(isNewer('', '0.11.1')).toBe(false);
  });
});

describe('updateCheckEnabled', () => {
  it('is on by default and off under any of the switches', () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ WARDEN_NO_UPDATE_CHECK: '1' })).toBe(false);
    expect(updateCheckEnabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(false);
    expect(updateCheckEnabled({ CI: 'true' })).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('reports a newer release with the command for a global install', async () => {
    const notice = await checkForUpdate({ current: '0.11.1', npx: false, cacheFile, fetchLatest: async () => '0.12.0' });
    expect(notice).toEqual({ current: '0.11.1', latest: '0.12.0', command: 'npm i -g @xbghc/warden@latest' });
  });

  it('gives an npx run the command that gets past the npx cache', async () => {
    const notice = await checkForUpdate({ current: '0.11.1', npx: true, cacheFile, fetchLatest: async () => '0.12.0' });
    expect(notice?.command).toBe('npx @xbghc/warden@latest');
  });

  it('has nothing to say when the running version is the latest', async () => {
    expect(await checkForUpdate({ current: '0.12.0', npx: false, cacheFile, fetchLatest: async () => '0.12.0' })).toBeNull();
  });

  it('asks the registry once a day and answers from the cache in between', async () => {
    const fetchLatest = vi.fn(async () => '0.12.0');
    const t0 = 1_800_000_000_000;
    await checkForUpdate({ current: '0.11.1', npx: false, cacheFile, fetchLatest, now: () => t0 });
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toEqual({ checkedAt: t0, latest: '0.12.0' });

    const cached = await checkForUpdate({ current: '0.11.1', npx: false, cacheFile, fetchLatest, now: () => t0 + CHECK_INTERVAL_MS - 1 });
    expect(cached?.latest).toBe('0.12.0');
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await checkForUpdate({ current: '0.11.1', npx: false, cacheFile, fetchLatest, now: () => t0 + CHECK_INTERVAL_MS });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('asks again when the cache is unreadable or dated in the future', async () => {
    const fetchLatest = vi.fn(async () => '0.12.0');
    const flat = path.join(dir, 'update-check.json');
    await writeFile(flat, '{ not json');
    await checkForUpdate({ current: '0.11.1', npx: false, cacheFile: flat, fetchLatest, now: () => 1000 });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await writeFile(flat, JSON.stringify({ checkedAt: 5000, latest: '0.11.1' }));
    const notice = await checkForUpdate({ current: '0.11.1', npx: false, cacheFile: flat, fetchLatest, now: () => 1000 });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(notice?.latest).toBe('0.12.0');
  });

  it('stays quiet and caches nothing when the registry cannot be reached', async () => {
    const offline = async () => {
      throw new Error('fetch failed');
    };
    expect(await checkForUpdate({ current: '0.11.1', npx: false, cacheFile, fetchLatest: offline })).toBeNull();
    await expect(readFile(cacheFile, 'utf8')).rejects.toThrow();
  });

  it('still answers when the cache cannot be written', async () => {
    // A file where the cache's directory should be: mkdir fails, the answer must not.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, '');
    const notice = await checkForUpdate({
      current: '0.11.1',
      npx: false,
      cacheFile: path.join(blocker, 'update-check.json'),
      fetchLatest: async () => '0.12.0',
    });
    expect(notice?.latest).toBe('0.12.0');
  });
});
