import { execFile } from 'node:child_process';

/** One process seen under an agent before the agent was signalled. */
export interface ProcessIdentity {
  pid: number;
  /** Start time as the OS prints it; a reused PID has a different one. */
  startedAt: string;
  command: string;
}

export interface ProcessTree {
  /** All live descendants of `root` by parent links, whatever their process group or session. */
  descendants(root: number): Promise<ProcessIdentity[]>;
  /** Members of an earlier snapshot that are still the same running process. */
  survivors(snapshot: readonly ProcessIdentity[]): Promise<ProcessIdentity[]>;
  /** Signal exactly these processes. */
  signal(targets: readonly ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void;
}

type Listed = ProcessIdentity & { ppid: number };

const LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

/** Parses `ps -o pid=,ppid=,stat=,lstart=,command=`. Zombies have exited and are left out. */
export function parseProcessList(output: string): Listed[] {
  const listed: Listed[] = [];
  for (const line of output.split('\n')) {
    const match = LINE.exec(line);
    if (!match || match[3]!.startsWith('Z')) continue;
    listed.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[4]!.replace(/\s+/g, ' '), command: match[5]!.slice(0, 200) });
  }
  return listed;
}

function list(): Promise<Listed[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-A', '-ww', '-o', 'pid=,ppid=,stat=,lstart=,command='],
      // The C locale fixes the lstart format the parser expects.
      { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(parseProcessList(stdout))),
    );
  });
}

/**
 * Parent links are the only relation every tool command of an agent shares: agents commonly start
 * commands in a session of their own, which a process-group signal cannot reach. Windows has no
 * `ps`; its process tree is not inspected.
 */
export const processTree: ProcessTree = {
  async descendants(root) {
    if (process.platform === 'win32') return [];
    const children = new Map<number, Listed[]>();
    for (const item of await list()) children.set(item.ppid, [...(children.get(item.ppid) ?? []), item]);
    const found: ProcessIdentity[] = [];
    const seen = new Set([root]);
    const queue = [root];
    while (queue.length) {
      for (const { ppid: _ppid, ...item } of children.get(queue.shift()!) ?? []) {
        if (seen.has(item.pid)) continue;
        seen.add(item.pid);
        found.push(item);
        queue.push(item.pid);
      }
    }
    return found;
  },
  async survivors(snapshot) {
    if (!snapshot.length) return [];
    const running = new Map((await list()).map((item) => [item.pid, item.startedAt]));
    return snapshot.filter((item) => running.get(item.pid) === item.startedAt);
  },
  signal(targets, signal) {
    for (const { pid } of targets) {
      // A snapshot never holds these, and signalling them would reach far beyond one agent.
      if (pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  },
};

const REAP_GRACE_MS = 500;

export type ReapOutcome = { kind: 'clean' } | { kind: 'reaped'; processes: ProcessIdentity[] } | { kind: 'unstopped'; processes: ProcessIdentity[] };

/**
 * Stops what a stopped agent left running. The agent owns its commands while it lives; once
 * Warden has stopped it, nothing else will, and a survivor keeps writing to the task workspace.
 */
export async function reapSurvivors(tree: ProcessTree, snapshot: readonly ProcessIdentity[]): Promise<ReapOutcome> {
  const first = await tree.survivors(snapshot);
  if (!first.length) return { kind: 'clean' };
  let remaining = first;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    tree.signal(remaining, signal);
    const deadline = Date.now() + REAP_GRACE_MS;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = await tree.survivors(remaining);
    } while (remaining.length && Date.now() < deadline);
    if (!remaining.length) return { kind: 'reaped', processes: first };
  }
  return { kind: 'unstopped', processes: remaining };
}

export const describeProcesses = (processes: readonly ProcessIdentity[]) =>
  processes
    .slice(0, 8)
    .map((item) => `${item.pid} (${item.command.slice(0, 80)})`)
    .join(', ');
