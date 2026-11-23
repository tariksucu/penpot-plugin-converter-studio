import {
  SOURCE,
  parsePluginMessage,
  type Notice,
  type Reply,
  type Request,
} from '../shared/messages';

/**
 * The panel's line to the plugin's code in Penpot. Requests go to the parent window with
 * `postMessage(…, '*')`, as Penpot's documentation says (the panel cannot know the origin of the
 * Penpot instance that opened it: penpot.app or a self-hosted one). They carry no secret: the
 * API key never leaves the panel. Answers are taken from the parent window only, and only when
 * they are well formed (`parsePluginMessage`).
 */

/** A request as the panel writes it: the bridge adds `source` and `id`. */
export type Ask = Request extends infer R
  ? R extends Request
    ? Omit<R, 'source' | 'id'>
    : never
  : never;

/** The plugin answered `failed`: Penpot's own reason. */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

export interface Bridge {
  /** Sends a request and waits for its answer (or `timeoutMs`). */
  ask(request: Ask, timeoutMs?: number): Promise<Exclude<Reply, { kind: 'failed' }>>;
  onNotice(listener: (notice: Notice) => void): void;
}

export interface BridgeWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Penpot answers most requests at once; an export renders the layer first. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export function createBridge(win: BridgeWindow): Bridge {
  let nextId = 1;
  const pending = new Map<number, { resolve: (reply: Reply) => void; timer: number }>();
  const listeners: Array<(notice: Notice) => void> = [];

  win.addEventListener('message', (event) => {
    // Penpot's page (the parent) is the only window the panel listens to.
    if (event.source !== (win.parent as unknown)) return;
    const message = parsePluginMessage(event.data);
    if (!message) return;
    if (message.kind === 'theme' || message.kind === 'selection') {
      for (const listener of listeners) listener(message);
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    waiting.resolve(message);
  });

  return {
    ask(request, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new PluginError('Penpot did not answer. Close the plugin and open it again.'));
        }, timeoutMs) as unknown as number;
        pending.set(id, {
          timer,
          resolve: (reply) =>
            reply.kind === 'failed' ? reject(new PluginError(reply.message)) : resolve(reply),
        });
        win.parent.postMessage({ ...request, source: SOURCE, id }, '*');
      });
    },
    onNotice(listener) {
      listeners.push(listener);
    },
  };
}
