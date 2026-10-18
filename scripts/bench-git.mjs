import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'source-root': { type: 'string' },
    workspaces: { type: 'string', default: '4' },
    files: { type: 'string', default: '1000' },
    samples: { type: 'string', default: '12' },
    label: { type: 'string', default: 'working-tree' },
    revision: { type: 'string' },
    operations: { type: 'string' },
  },
});
const root = path.resolve(values['source-root'] ?? fileURLToPath(new URL('..', import.meta.url)));
const workspaceCount = Number(values.workspaces);
const fileCount = Number(values.files);
const samples = Number(values.samples);
const selectedOperations = values.operations ? new Set(values.operations.split(',')) : undefined;
for (const [name, value, maximum] of [
  ['workspaces', workspaceCount, 32],
  ['files', fileCount, 100_000],
  ['samples', samples, 1000],
]) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}: ${value}`);
}

// Synthetic fixtures must not inherit a developer's hook, object-store or tracing configuration.
for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
const moduleAt = (file) => import(pathToFileURL(path.join(root, file)).href);
const [{ makeFixtureRepo }, { WorkflowService }, { StateStore }, { resolveRepo }, { RepoWatcher }] = await Promise.all([
  moduleAt('test/fixtures/make-repo.ts'),
  moduleAt('packages/server/src/workflow.ts'),
  moduleAt('packages/server/src/state.ts'),
  moduleAt('packages/server/src/repo.ts'),
  moduleAt('packages/server/src/watcher.ts'),
]);
const fx = await makeFixtureRepo('warden-read-bench-');
const data = await mkdtemp(path.join(os.tmpdir(), 'warden-read-bench-data-'));
const trace = path.join(data, 'git-trace.json');
const workspaces = [];
const watchers = [];
const measurements = [];
const rounded = (value) => Math.round(value * 100) / 100;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

async function measure(name, operation) {
  if (selectedOperations && !selectedOperations.has(name)) return;
  const observations = [];
  for (let i = 0; i < samples; i++) {
    await writeFile(trace, '');
    const cpu = process.cpuUsage();
    const start = performance.now();
    await operation();
    const elapsed = performance.now() - start;
    const consumed = process.cpuUsage(cpu);
    const events = (await readFile(trace, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const starts = events.filter((event) => event.event === 'start');
    observations.push({
      wallMs: rounded(elapsed),
      nodeCpuMs: rounded((consumed.user + consumed.system) / 1000),
      gitProcesses: starts.filter((event) => !event.sid.includes('/')).length,
      gitProcessesIncludingChildren: starts.length,
    });
  }
  measurements.push({
    name,
    medianMs: median(observations.map((row) => row.wallMs)),
    p95Ms: p95(observations.map((row) => row.wallMs)),
    medianNodeCpuMs: median(observations.map((row) => row.nodeCpuMs)),
    medianGitProcesses: median(observations.map((row) => row.gitProcesses)),
    observations,
  });
}

try {
  // Populate tracked files before creating worktrees, using bounded fixture filesystem activity.
  for (let first = 0; first < fileCount; first += 100) {
    await Promise.all(Array.from({ length: Math.min(100, fileCount - first) }, (_, i) => fx.write(`bench/file-${first + i}.txt`, `content ${first + i}\n`)));
  }
  fx.git('add', '.');
  fx.git('commit', '-qm', 'Benchmark files');
  fx.git('switch', '-qc', 'feature/benchmark');
  const repo = await resolveRepo(fx.root);
  const store = new StateStore(path.join(data, 'state.json'), fx.root);
  const workflow = new WorkflowService(repo, store);
  await workflow.configure('feature/benchmark');
  for (let i = 0; i < workspaceCount; i++) {
    const planned = await workflow.create({ title: `Task ${i + 1}` });
    workspaces.push(await workflow.start(planned.id, { kind: 'worktree' }));
  }
  for (const directory of [fx.root, ...workspaces.map((row) => row.worktree)]) watchers.push(new RepoWatcher(directory, 60_000));
  // The same trace path remains in every measured environment, including cache warm-up. Trace
  // parsing happens after the timer and counts direct Git calls separately from Git's own children.
  process.env.GIT_TRACE2_EVENT = trace;
  await Promise.all(watchers.map((watcher) => watcher.poll()));
  await measure('idle_watchers', () => Promise.all(watchers.map((watcher) => watcher.poll())));
  await workflow.get();
  await measure('workflow_get', async () => {
    const response = await workflow.get();
    assert.equal(response.error, undefined);
    assert.equal(response.workflow.changes.length, workspaceCount);
  });
  const verifyChecks = (result, expected) => {
    assert.equal(result.checks.length, workspaceCount);
    for (const check of result.checks) assert.equal(check.status, expected);
  };
  await measure('sync_current', async () => verifyChecks(await workflow.rebaseChecks(), 'current'));

  for (let i = 0; i < workspaces.length; i++) {
    const cwd = workspaces[i].worktree;
    await writeFile(path.join(cwd, `task-${i}.txt`), `task ${i}\n`);
    fx.git('-C', cwd, 'add', '.');
    fx.git('-C', cwd, 'commit', '-qm', `Task ${i}`);
  }
  await fx.write('primary.txt', 'primary advanced\n');
  fx.git('add', '.');
  fx.git('commit', '-qm', 'Advance primary');
  await measure('sync_behind_cold', async () => verifyChecks(await new WorkflowService(repo, store).rebaseChecks(), 'ready'));
  verifyChecks(await workflow.rebaseChecks(), 'ready');
  await measure('sync_behind_warm', async () => verifyChecks(await workflow.rebaseChecks(), 'ready'));
  delete process.env.GIT_TRACE2_EVENT;
  console.log(
    JSON.stringify(
      {
        label: values.label,
        sourceRevision: values.revision ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sourceHasChanges: values.revision ? undefined : execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        git: fx.git('--version').trim(),
        native: process.env.WARDEN_NATIVE ?? 'auto',
        workspaces: workspaceCount,
        trackedFilesAdded: fileCount,
        samples,
        nodePeakRssMiB: rounded(process.resourceUsage().maxRSS / 1024),
        notes:
          'Warm filesystem cache. Node CPU and peak RSS include Rust in-process; they exclude Git child-process CPU and memory. Timing includes Git Trace2 overhead. No preview connections.',
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  delete process.env.GIT_TRACE2_EVENT;
  await Promise.all(watchers.map((watcher) => watcher.close()));
  await Promise.all(workspaces.map((row) => rm(row.worktree, { recursive: true, force: true })));
  await fx.cleanup();
  await rm(data, { recursive: true, force: true });
}
