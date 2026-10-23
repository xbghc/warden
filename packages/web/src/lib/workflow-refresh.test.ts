import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowResponse, WorktreesResponse } from '@warden/shared';
import { api } from '../api';
import { useWorkflow } from '../workflow-store';

vi.mock('../api', () => ({ api: { workflow: vi.fn(), worktrees: vi.fn() } }));
vi.mock('../store', () => ({ useStore: { getState: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function queueRefresh(version: number) {
  const data: WorkflowResponse = {
    workflow: { developmentBranch: 'main', changes: [] },
    developmentHead: String(version).repeat(40),
  };
  const checkouts: WorktreesResponse = {
    worktrees: [],
    branches: [{ name: 'main', sha: data.developmentHead! }],
    newSlot: { slot: version, path: `/project-${version}` },
    slotKind: 'shared',
  };
  const workflow = deferred<WorkflowResponse>();
  const worktrees = deferred<WorktreesResponse>();
  vi.mocked(api.workflow).mockReturnValueOnce(workflow.promise);
  vi.mocked(api.worktrees).mockReturnValueOnce(worktrees.promise);
  return {
    data,
    checkouts,
    succeed() {
      workflow.resolve(data);
      worktrees.resolve(checkouts);
    },
    fail(error: Error) {
      workflow.reject(error);
      worktrees.resolve(checkouts);
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useWorkflow.setState({ data: null, checkouts: null, error: null });
});

describe('workflow refresh concurrency', () => {
  it('publishes a completed refresh while a newer automatic refresh is still pending', async () => {
    const explicit = queueRefresh(1);
    const automatic = queueRefresh(2);
    const first = useWorkflow.getState().refresh();
    const second = useWorkflow.getState().refresh();
    try {
      explicit.succeed();
      await first;
      expect(useWorkflow.getState()).toMatchObject({ data: explicit.data, checkouts: explicit.checkouts, error: null });
    } finally {
      automatic.succeed();
      await second;
    }
    expect(useWorkflow.getState()).toMatchObject({ data: automatic.data, checkouts: automatic.checkouts, error: null });
  });

  it('does not overwrite a newer completed snapshot when the older request finishes last', async () => {
    const older = queueRefresh(1);
    const newer = queueRefresh(2);
    const first = useWorkflow.getState().refresh();
    const second = useWorkflow.getState().refresh();
    newer.succeed();
    await second;
    older.succeed();
    await first;
    expect(useWorkflow.getState()).toMatchObject({ data: newer.data, checkouts: newer.checkouts, error: null });
  });

  it('still publishes an earlier successful snapshot after a later refresh fails', async () => {
    const older = queueRefresh(1);
    const newer = queueRefresh(2);
    const first = useWorkflow.getState().refresh();
    const second = useWorkflow.getState().refresh();
    newer.fail(new Error('Automatic refresh failed'));
    await second;
    older.succeed();
    await first;
    expect(useWorkflow.getState()).toMatchObject({ data: older.data, checkouts: older.checkouts });
  });
});
