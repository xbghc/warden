import { describe, expect, it } from 'vitest';
import { parseWorktreeState } from './worktree-state.js';

const oid = '1'.repeat(40);
const headers = `# branch.oid ${oid}\0# branch.head main\0`;

describe('portable worktree status parser', () => {
  it('keeps paths intact and counts renames and unmerged paths once', () => {
    const status =
      headers +
      `1 MM N... 100644 100644 100644 ${oid} ${oid} space name.txt\0` +
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new\nname.txt\0old name.txt\0` +
      `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt\0` +
      '? 中文 [literal].txt\0! ignored.txt\0';
    expect(parseWorktreeState(status)).toMatchObject({
      head: oid,
      branch: 'main',
      dirtyCount: 4,
      paths: ['space name.txt', 'new\nname.txt', 'old name.txt', 'conflict.txt', '中文 [literal].txt'],
    });
  });

  it('represents unborn and detached checkouts without inventing a commit or branch', () => {
    expect(parseWorktreeState('# branch.oid (initial)\0# branch.head topic\0')).toMatchObject({ branch: 'topic', dirtyCount: 0 });
    expect(parseWorktreeState('# branch.oid (initial)\0# branch.head topic\0').head).toBeUndefined();
    expect(parseWorktreeState(`# branch.oid ${oid}\0# branch.head (detached)\0`).branch).toBeUndefined();
  });

  it('distinguishes raw filename bytes that decode to the same displayed path', () => {
    const raw = Buffer.concat([Buffer.from(headers + '? raw'), Buffer.from([0xff]), Buffer.from('.txt\0')]);
    const decoded = Buffer.from(raw.toString('utf8'));
    const state = parseWorktreeState(raw);
    expect(state).toMatchObject({ dirtyCount: 1, paths: ['raw\ufffd.txt'] });
    expect(state.paths).toEqual(parseWorktreeState(decoded).paths);
    expect(state.statusFingerprint).not.toBe(parseWorktreeState(decoded).statusFingerprint);
  });

  it('allows future headers while rejecting truncated entries and missing identity', () => {
    expect(parseWorktreeState(headers + '# future.header value\0').dirtyCount).toBe(0);
    for (const malformed of ['', headers.slice(0, -1), '? untracked.txt\0', headers + '1 M\0', headers + '2 R. N... 100644\0']) {
      expect(() => parseWorktreeState(malformed)).toThrow('porcelain v2');
    }
  });
});
