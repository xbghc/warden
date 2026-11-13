// A disposable, test-only host for exercising the packaged webview in a real browser.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';
import { Engine } from '@warden/engine';
import { parseWorkbenchAction, taskReview } from '@warden/shared';
import type { Surface, WorkbenchModel, AcpConfiguration, AcpReadiness } from '@warden/shared';
import { makeFixtureRepo } from '../fixtures/make-repo.js';

const fixture = await makeFixtureRepo('warden-ui-');
const data = await mkdtemp(path.join(os.tmpdir(), 'warden-ui-data-'));
const engine = await Engine.open(fixture.root, path.join(data, 'state.json'));
let selected: string | undefined;
const messages: Record<string, string> = {};
const expanded: Record<string, boolean> = {};
const session = 'browser-fixture';
let agentConfiguration: AcpConfiguration = { status: 'missing' };
let agentReadiness: AcpReadiness = { status: 'unchecked' };
const manifest = JSON.parse(await readFile('packages/vscode/package.json', 'utf8'));
const assets = unzipSync(await readFile(`packages/vscode/warden-${manifest.version}.vsix`));
const model = async (surface: Surface): Promise<WorkbenchModel> => {
  const workflow = await engine.execute('workflow.get', undefined);
  const [composed, workspaces] = await Promise.all([engine.execute('preview.get', undefined), engine.execute('workspaces.list', undefined)]);
  const task = workflow.workflow?.changes.find((row) => row.id === selected);
  return {
    session,
    repository: fixture.root,
    repositoryState: 'ready',
    agentConfiguration,
    agentReadiness,
    surface,
    workflow,
    task,
    workspaces: await Promise.all(
      (workflow.workflow?.changes ?? []).map(async (row) => {
        const review = row.worktree ? taskReview(workflow, row.id, workspaces.worktrees) : undefined;
        return {
          task: row,
          expanded: !!expanded[row.id],
          description: row.worktree ? 'Not in Preview' : 'Prepared on first use',
          tooltip: [row.title, row.worktree].filter(Boolean).join('\n'),
          files: expanded[row.id] && review ? (await engine.execute('review.files', { key: review.targetKey })).files : undefined,
        };
      }),
    ),
    preview: composed,
    hasPreviewCommand: false,
    review: selected ? taskReview(workflow, selected, workspaces.worktrees) : undefined,
    reviewCurrent: false,
    message: task ? (messages[task.id] ?? task.title) : '',
    errors: [],
    checks: workflow.workflow && (surface === 'rebase' || surface === 'workspaces') ? await engine.execute('rebase.check', undefined) : undefined,
  };
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://localhost');
    const surface = (url.searchParams.get('surface') ?? 'rebase') as Surface;
    if (url.pathname === '/inspect') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Warden · 表单验证</title><body style="background:#eee;font:13px sans-serif;padding:20px;display:flex;gap:24px">
        ${['light', 'dark', 'contrast'].map((theme) => `<section><h2>${{ light: '浅色', dark: '深色', contrast: '高对比' }[theme]} · 320px</h2><iframe title="${theme}" src="/?surface=rebase&theme=${theme}" style="width:320px;height:700px;border:1px solid #888"></iframe></section>`).join('')}
      </body></html>`);
      return;
    }
    if (url.pathname === '/model') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(await model(surface)));
      return;
    }
    if (url.pathname === '/action' && request.method === 'POST') {
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 128000) throw new Error('oversized action');
      }
      const action = parseWorkbenchAction(JSON.parse(text));
      switch (action.type) {
        case 'setup.agents':
          break;
        case 'settings.agents':
          if (agentConfiguration.status !== 'configured') {
            agentConfiguration = { status: 'configured', count: 1 };
            agentReadiness = { status: 'ready', profile: { id: 'fixture', label: 'Fixture agent' }, message: 'ACP connected.' };
          }
          break;
        case 'setup.checkAgent':
          agentReadiness = { status: 'ready', profile: { id: 'fixture', label: 'Fixture agent' }, message: 'ACP connected.' };
          break;
        case 'setup.cancelAgentCheck':
          agentReadiness = { status: 'unchecked' };
          break;
        case 'task.select':
        case 'task.file':
        case 'task.review':
        case 'task.history':
        case 'task.output':
        case 'task.options':
          selected = action.taskId;
          break;
        case 'task.toggle':
          expanded[action.taskId] = action.expanded;
          break;
        case 'task.move':
          await engine.execute('task.move', { taskId: action.taskId, before: action.before });
          break;
        case 'task.connect': {
          const current = await engine.execute('preview.get', undefined);
          await engine.execute('preview.connect', {
            connectedIds: current.connectedIds.includes(action.taskId)
              ? current.connectedIds.filter((id) => id !== action.taskId)
              : [...current.connectedIds, action.taskId],
          });
          break;
        }
        case 'setup.branch':
          await engine.execute('workflow.configure', { branch: 'main' });
          await engine.execute('preview.refresh', undefined);
          break;
        case 'task.create': {
          const task = await engine.execute('task.create', { title: action.title });
          selected = task.id;
          if (task.worktree) await writeFile(path.join(task.worktree, 'ui-fixture.txt'), 'Workspace file for native diff routing\n');
          break;
        }
        case 'task.start': {
          await engine.execute('task.start', { taskId: action.taskId, kind: action.kind, agent: action.agent });
          break;
        }
        case 'task.update':
          await engine.execute('task.update', { taskId: action.taskId, title: action.title });
          break;
        case 'task.message':
          messages[action.taskId] = action.message;
          break;
        case 'task.hook':
          await engine.execute('task.hook', { taskId: action.taskId });
          break;
        case 'settings.save':
          await engine.execute('config.save', action.config);
          break;
        case 'preview.refresh':
          await engine.execute('preview.refresh', undefined);
          break;
        case 'preview.setup':
          await engine.execute('preview.setup', undefined);
          break;
        default:
          break;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(await model(action.type === 'setup.agents' ? 'settings' : surface)));
      return;
    }
    if (url.pathname === '/index.js' || url.pathname === '/index.css') {
      response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(Buffer.from(assets[`extension/dist/webview${url.pathname}`]!));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    const theme = url.searchParams.get('theme');
    const dark = theme === 'dark' || theme === 'contrast';
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/index.css">
      ${dark ? `<style>:root { --vscode-editor-background:#1f1f1f; --vscode-sideBar-background:#181818; --vscode-editor-foreground:#ddd; --vscode-button-background:#0e639c; --vscode-button-foreground:#fff; --vscode-descriptionForeground:#aaa; --vscode-textCodeBlock-background:#252525; --vscode-list-hoverBackground:#333; --vscode-widget-border:#555; --vscode-input-border:#666; --vscode-focusBorder:#007fd4; ${theme === 'contrast' ? '--vscode-contrastBorder:#fff; --vscode-focusBorder:#f38518; --vscode-widget-border:#fff; --vscode-input-border:#fff;' : ''} }</style>` : ''}
      </head><body class="${dark ? (theme === 'contrast' ? 'vscode-high-contrast' : 'vscode-dark') : 'vscode-light'}"><div id="root"></div><script>
      let surface = new URL(location.href).searchParams.get('surface') || 'rebase';
      let queue = Promise.resolve();
      window.__actions = [];
      // Like VS Code, keep webview state across a rebuilt page of the same panel.
      const stateKey = 'warden-state:' + surface;
      window.acquireVsCodeApi = () => ({
        getState: () => JSON.parse(sessionStorage.getItem(stateKey) ?? 'null') ?? undefined,
        setState: value => sessionStorage.setItem(stateKey, JSON.stringify(value)),
        postMessage: message => {
        if (message.action) window.__actions.push(message.action);
        queue = queue.then(async () => {
          const response = await fetch((message.type === 'ready' ? '/model' : '/action') + '?surface=' + surface,
            message.type === 'ready' ? {} : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(message.action) });
          if (!response.ok) throw new Error(await response.text());
          const model = await response.json();
          surface = model.surface;
          window.postMessage({ type:'model', model }, '*');
          if (message.action?.type === 'settings.save') window.__settingsSaved = true;
        }).catch(error => { window.__hostError = String(error); console.error(error); });
      }});
    </script><script src="/index.js"></script></body></html>`);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
server.listen(Number(process.env.WARDEN_UI_PORT ?? 0), process.env.WARDEN_UI_HOST ?? '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ port: typeof address === 'object' ? address?.port : undefined, root: fixture.root }));
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const allocated = await engine.execute('workspaces.list', undefined);
  await engine.close();
  const prefix = `${fixture.root}-`;
  for (const workspace of allocated.worktrees)
    if (workspace.path.startsWith(prefix) && /^\d+$/.test(workspace.path.slice(prefix.length))) await rm(workspace.path, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(data, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
