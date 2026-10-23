import { createApp, resolveRepo, StateStore, stateFilePath } from '@warden/server';
import { PreviewService } from '../../server/src/preview.js';

/** The same validated API as the CLI, without a listening socket in the extension host. */
export class Backend {
  private pending?: Promise<void>;
  private notifying?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private constructor(
    readonly root: string,
    private app: ReturnType<typeof createApp>,
    private preview: PreviewService,
  ) {}
  static async open(directory: string, file?: string) {
    const repo = await resolveRepo(directory);
    const store = new StateStore(file ?? stateFilePath(repo.commonRoot), repo.commonRoot);
    return new Backend(repo.commonRoot, createApp({ repo, store }), new PreviewService(repo, store));
  }
  async request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.app.request(`http://127.0.0.1/api${route}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error((data as { error?: string }).error ?? `Warden: HTTP ${response.status}`);
    return data as T;
  }
  start(onUpdate: () => Promise<void>, onError: (error: unknown) => void) {
    this.timer = setInterval(() => {
      if (!this.pending)
        this.pending = this.preview
          .tick()
          .catch(onError)
          .finally(() => {
            this.pending = undefined;
          });
      // Progress remains observable while a serialized setup or publication is running.
      if (!this.notifying)
        this.notifying = onUpdate()
          .catch(onError)
          .finally(() => {
            this.notifying = undefined;
          });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all([this.pending, this.notifying]);
    await this.app.close();
  }
}
