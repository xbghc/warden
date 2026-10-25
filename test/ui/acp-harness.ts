// A disposable ACP host using the packaged UI and a real stdio fixture agent.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';
import { Engine } from '@warden/engine';
import { parseAcpAction } from '@warden/shared';
import type { AcpAction, AcpBinding, AcpModel } from '@warden/shared';
import type { AcpProfile } from '../../packages/vscode/src/acp/contracts.js';
import { AcpDraft } from '../../packages/vscode/src/acp/draft.js';
import { AcpSession } from '../../packages/vscode/src/acp/session.js';
import { AcpSessionStorage } from '../../packages/vscode/src/acp/storage.js';
import { resolveAcpBinding, validateAcpBinding } from '../../packages/vscode/src/acp/binding.js';
import { makeFixtureRepo } from '../fixtures/make-repo.js';

const fixture = await makeFixtureRepo('warden-acp-ui-');
await fixture.write('context.txt', 'primary baseline\n');
fixture.git('add', 'context.txt');
fixture.git('commit', '-m', 'Add agent context');
const data = await mkdtemp(path.join(os.tmpdir(), 'warden-acp-ui-data-'));
const engine = await Engine.open(fixture.root, path.join(data, 'state.json'));
await engine.execute('workflow.configure', { branch: 'main' });
const preview = await engine.execute('preview.refresh', undefined);
const manifest = JSON.parse(await readFile('packages/vscode/package.json', 'utf8'));
const assets = unzipSync(await readFile(`packages/vscode/warden-${manifest.version}.vsix`));

interface Entry {
  binding: AcpBinding;
  panelId: string;
  session: AcpSession;
  profiles: AcpProfile[];
  draft: AcpDraft;
  sending: boolean;
  error?: string;
}
const entries: Entry[] = [];
for (const [index, title] of ['订单筛选参数', '分页默认值'].entries()) {
  const task = await engine.execute('task.create', { title });
  await engine.execute('task.start', { taskId: task.id, kind: 'shared' });
  const binding = await resolveAcpBinding(engine, task.id);
  await writeFile(path.join(binding.workspace, 'context.txt'), `task ${index + 1}\n`);
  const profiles = ['normal', 'no-load', 'auth', 'incompatible'].map((mode) => ({
    id: mode,
    label: { normal: '测试 Agent', 'no-load': '不支持恢复的 Agent', auth: '需要登录的 Agent', incompatible: '不兼容的 Agent' }[mode]!,
    command: process.execPath,
    args: [path.resolve('test/fixtures/acp-agent.mjs'), path.join(data, `${index}-${mode}.jsonl`), mode],
  }));
  const session = new AcpSession({
    binding,
    storage: new AcpSessionStorage(path.join(data, 'acp'), binding),
    validate: () => validateAcpBinding(engine, binding),
    changed: () => {},
    timeoutMs: 3000,
  });
  await session.initialize();
  entries.push({ binding, panelId: `panel-${index}`, session, profiles, draft: new AcpDraft(`请完成${title}。`), sending: false });
}

const model = (entry: Entry): AcpModel => ({
  ...entry.session.snapshot(),
  error: entry.error ?? entry.session.snapshot().error,
  panelId: entry.panelId,
  profiles: entry.profiles.map(({ id, label }) => ({ id, label })),
  ...entry.draft.snapshot(),
});
const profile = (entry: Entry, id: string) => {
  const found = entry.profiles.find((candidate) => candidate.id === id);
  if (!found) throw new Error('Unknown fixture profile');
  return found;
};
async function act(entry: Entry, action: AcpAction) {
  if (action.type === 'draft') {
    entry.draft.update(action);
    return;
  }
  entry.error = undefined;
  switch (action.type) {
    case 'send': {
      if (entry.sending) throw new Error('A prompt is already running');
      const submitted = entry.draft.begin(action);
      entry.sending = true;
      try {
        const snapshot = entry.session.snapshot();
        if (snapshot.status !== 'connected') {
          if (snapshot.record.sessionId) throw new Error('Restore or create a conversation first');
          await entry.session.connect(profile(entry, action.profileId), { resume: false });
        }
        await entry.session.send(submitted.text);
        if (!entry.session.snapshot().record.interrupted) entry.draft.complete(submitted.mutation);
      } finally {
        entry.sending = false;
      }
      break;
    }
    case 'connect':
      await entry.session.connect(profile(entry, action.profileId), { resume: action.resume });
      break;
    case 'disconnect':
      await entry.session.disconnect();
      break;
    case 'cancel':
      await entry.session.cancel();
      break;
    case 'new':
      await entry.session.newConversation();
      break;
    case 'permission':
      await entry.session.respondPermission(action.requestId, action.optionId);
      break;
    case 'authenticate':
      await entry.session.authenticate(action.methodId);
      break;
    case 'configure':
    case 'review':
      break;
  }
}
const optionalFile = (file: string) => readFile(file, 'utf8').catch(() => null);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://localhost');
    const entry = entries[Number(url.searchParams.get('task') ?? 0)];
    if (!entry) throw new Error('Unknown fixture task');
    if (url.pathname === '/model') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(model(entry)));
      return;
    }
    if (url.pathname === '/reopen' && request.method === 'POST') {
      entry.panelId = randomUUID();
      entry.draft.resetPanel();
      response.end('{}');
      return;
    }
    if (url.pathname === '/append' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 128000) throw new Error('Oversized fixture selection');
      }
      const { text } = JSON.parse(body);
      if (typeof text !== 'string') throw new Error('Invalid fixture selection');
      const before = model(entry);
      entry.draft.append(text);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([before, model(entry)]));
      return;
    }
    if (url.pathname === '/inspect') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          primaryStatus: fixture.git('status', '--porcelain'),
          primaryContext: await optionalFile(path.join(fixture.root, 'context.txt')),
          previewContext: await optionalFile(path.join(preview.worktree!, 'context.txt')),
          entries: await Promise.all(
            entries.map(async (item) => ({
              model: model(item),
              output: await optionalFile(path.join(item.binding.workspace, 'agent-output.txt')),
              journals: await Promise.all(item.profiles.map((agent) => optionalFile(agent.args[1]!))),
            })),
          ),
        }),
      );
      return;
    }
    if (url.pathname === '/action' && request.method === 'POST') {
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 128000) throw new Error('Oversized fixture action');
      }
      const message = JSON.parse(text);
      if (message.panelId !== entry.panelId) throw new Error('Wrong fixture panel');
      const action = parseAcpAction(message.action);
      // Accept a short action immediately so permission responses and cancellation stay usable.
      void act(entry, action).catch((error) => {
        entry.error = error instanceof Error ? error.message : String(error);
      });
      response.statusCode = 202;
      response.end('{}');
      return;
    }
    if (url.pathname === '/index.js' || url.pathname === '/index.css') {
      response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(Buffer.from(assets[`extension/dist/webview${url.pathname}`]!));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/index.css"></head><body><div id="root"></div><script>
      const task = new URL(location.href).searchParams.get('task') || '0';
      let saved, refreshing, modelsPaused = false;
      let queue = Promise.resolve();
      let draftGate, releaseDrafts;
      const publish = model => {
        window.__model = model;
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'acp-model', model } }));
      };
      const refresh = () => {
        if (modelsPaused) return Promise.resolve();
        if (refreshing) return refreshing;
        refreshing = (async () => {
          const model = await (await fetch('/model?task=' + task)).json();
          publish(model);
        })().finally(() => { refreshing = undefined; });
        return refreshing;
      };
      window.__actions = [];
      window.__fixture = {
        deliver: publish,
        pauseModels: async () => { modelsPaused = true; await refreshing; },
        resumeModels: async () => { modelsPaused = false; await refresh(); },
        holdDrafts: () => { draftGate = new Promise(resolve => { releaseDrafts = resolve; }); },
        releaseDrafts: async () => { releaseDrafts(); draftGate = undefined; await queue; await refresh(); },
        append: async (text, deliver = true) => {
          const response = await fetch('/append?task=' + task, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
          });
          if (!response.ok) throw new Error(await response.text());
          // A reveal and its subsequent append may be delivered before React renders either.
          // Publishing both together prevents polling from accidentally masking that race.
          const models = await response.json();
          if (deliver) for (const model of models) publish(model);
          return models;
        },
      };
      window.acquireVsCodeApi = () => ({ getState: () => saved, setState: value => saved = value, postMessage: message => {
        if (message.type === 'ready') { void refresh(); return; }
        window.__actions.push(message);
        queue = queue.then(async () => {
          if (message.action?.type === 'draft' && draftGate) await draftGate;
          const response = await fetch('/action?task=' + task, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(message) });
          if (!response.ok) throw new Error(await response.text());
          await refresh();
        }).catch(error => { window.__hostError = String(error); console.error(error); });
      }});
      setInterval(() => void refresh(), 60);
    </script><script src="/index.js"></script></body></html>`);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ port: typeof address === 'object' ? address?.port : undefined }));
});
async function close() {
  server.close();
  server.closeAllConnections();
  await Promise.all(entries.map((entry) => entry.session.close()));
  await engine.close();
  await Promise.all(entries.map((entry) => rm(entry.binding.workspace, { recursive: true, force: true })));
  await fixture.cleanup();
  await rm(data, { recursive: true, force: true });
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
