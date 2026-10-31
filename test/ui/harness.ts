// A disposable, test-only host for exercising the packaged webview in a real browser.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';
import { Engine } from '@warden/engine';
import { parseWorkbenchAction, taskReview } from '@warden/shared';
import type { Surface, WorkbenchModel } from '@warden/shared';
import type { Memento } from 'vscode';
import { TaskNoteDrafts } from '../../packages/vscode/src/task-note-drafts.js';
import { makeFixtureRepo } from '../fixtures/make-repo.js';

const fixture = await makeFixtureRepo('warden-ui-');
const data = await mkdtemp(path.join(os.tmpdir(), 'warden-ui-data-'));
const engine = await Engine.open(fixture.root, path.join(data, 'state.json'));
let selected: string | undefined;
const messages: Record<string, string> = {};
const savedNotes = new Map<string, unknown>();
const notes = new TaskNoteDrafts({
  keys: () => [...savedNotes.keys()],
  get: <T>(key: string, fallback?: T) => (savedNotes.has(key) ? (savedNotes.get(key) as T) : fallback),
  update: async (key: string, value: unknown) => {
    savedNotes.set(key, value);
  },
} as Memento);
const expanded: Record<string, boolean> = {};
const session = 'browser-fixture';
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
    surface,
    workflow,
    task,
    taskDraft: task && notes.read(fixture.root, task.id),
    workspaces: await Promise.all(
      (workflow.workflow?.changes ?? []).map(async (row) => {
        const review = row.worktree ? taskReview(workflow, row.id, workspaces.worktrees) : undefined;
        return {
          task: row,
          expanded: !!expanded[row.id],
          description: row.worktree ? 'Not in Preview' : 'Prepared on first use',
          tooltip: [row.title, row.body, row.worktree].filter(Boolean).join('\n'),
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
    const surface = (url.searchParams.get('surface') ?? 'task') as Surface;
    if (url.pathname === '/inspect') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Warden · 表单验证</title><body style="background:#eee;font:13px sans-serif;padding:20px;display:flex;gap:24px">
        ${['light', 'dark', 'contrast'].map((theme) => `<section><h2>${{ light: '浅色', dark: '深色', contrast: '高对比' }[theme]} · 320px</h2><iframe title="${theme}" src="/?surface=task&theme=${theme}" style="width:320px;height:700px;border:1px solid #888"></iframe></section>`).join('')}
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
        case 'task.select':
        case 'task.file':
        case 'task.review':
        case 'task.edit':
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
          const task = await engine.execute('task.create', { title: action.title, body: action.body });
          selected = task.id;
          if (task.worktree) await writeFile(path.join(task.worktree, 'ui-fixture.txt'), 'Workspace file for native diff routing\n');
          break;
        }
        case 'task.start': {
          await engine.execute('task.start', { taskId: action.taskId, kind: action.kind, agent: action.agent });
          break;
        }
        case 'task.draft': {
          const task = (await engine.execute('workflow.get', undefined)).workflow?.changes.find((item) => item.id === action.taskId);
          if (!task) throw new Error('Unknown draft task');
          await notes.save(fixture.root, task.id, action, { title: task.title, body: task.body ?? '' });
          break;
        }
        case 'task.update':
          await engine.execute('task.update', { taskId: action.taskId, title: action.title, body: action.body });
          await notes.saved(fixture.root, action.taskId, { title: action.title.trim(), body: action.body.trim() });
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
      response.end(JSON.stringify(await model(surface)));
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
      const surface = new URL(location.href).searchParams.get('surface') || 'task';
      let saved = JSON.parse(sessionStorage.getItem('warden-state') || '{}');
      let queue = Promise.resolve();
      window.__actions = [];
      window.acquireVsCodeApi = () => ({ getState: () => saved, setState: s => { saved=s; sessionStorage.setItem('warden-state', JSON.stringify(s)); }, postMessage: message => {
        if (message.action) window.__actions.push(message.action);
        queue = queue.then(async () => {
          const response = await fetch((message.type === 'ready' ? '/model' : '/action') + '?surface=' + surface,
            message.type === 'ready' ? {} : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(message.action) });
          if (!response.ok) throw new Error(await response.text());
          const updated = await response.json();
          if (message.action?.type !== 'task.draft') window.postMessage({ type:'model', model:updated }, '*');
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
async function close() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await engine.close();
  for (const slot of [1, 2]) await rm(`${fixture.root}-${slot}`, { recursive: true, force: true });
  await fixture.cleanup();
  await rm(data, { recursive: true, force: true });
}
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
