import { describe, expect, it, vi } from 'vitest';
import { PluginError, createBridge, type BridgeWindow } from '../src/ui/bridge';
import { keyStore, isApiKey } from '../src/ui/key-store';
import { themeFromLocation } from '../src/ui/theme';
import { SOURCE } from '../src/shared/messages';
import { KEY } from './fake-server';

function fakeWindow() {
  const posted: Array<{ message: Record<string, unknown>; origin: string }> = [];
  let listener: ((event: MessageEvent) => void) | null = null;
  const parent = {
    postMessage: (message: unknown, origin: string) =>
      posted.push({ message: message as Record<string, unknown>, origin }),
  };
  const win: BridgeWindow = {
    parent,
    addEventListener: (_type, callback) => (listener = callback),
  };
  const deliver = (data: unknown, source: unknown = parent) =>
    listener?.({ data, source } as unknown as MessageEvent);
  return { win, posted, deliver, parent };
}

const selection = { count: 0, layers: [], destination: { kind: 'page', name: null } };

describe('the panel’s line to the plugin', () => {
  it('sends requests to the parent with an id and resolves them with the matching answer', async () => {
    const { win, posted, deliver } = fakeWindow();
    const bridge = createBridge(win);
    const first = bridge.ask({ kind: 'hello' });
    const second = bridge.ask({ kind: 'export', layerId: 'b1', type: 'png', scale: 2 });
    expect(posted).toEqual([
      { message: { kind: 'hello', source: SOURCE, id: 1 }, origin: '*' },
      {
        message: { kind: 'export', layerId: 'b1', type: 'png', scale: 2, source: SOURCE, id: 2 },
        origin: '*',
      },
    ]);
    deliver({ source: SOURCE, kind: 'exported', id: 2, name: 'Hero', bytes: new Uint8Array([1]) });
    deliver({ source: SOURCE, kind: 'context', id: 1, theme: 'dark', selection });
    await expect(second).resolves.toMatchObject({ kind: 'exported', name: 'Hero' });
    await expect(first).resolves.toMatchObject({ kind: 'context' });
  });

  it('rejects with Penpot’s reason when the plugin answers failed', async () => {
    const { win, deliver } = fakeWindow();
    const bridge = createBridge(win);
    const asked = bridge.ask({ kind: 'hello' });
    deliver({ source: SOURCE, kind: 'failed', id: 1, message: 'The file is read-only' });
    await expect(asked).rejects.toEqual(new PluginError('The file is read-only'));
  });

  it('listens to the parent window only, and to well-formed messages only', async () => {
    const { win, deliver } = fakeWindow();
    const bridge = createBridge(win);
    const notices: unknown[] = [];
    bridge.onNotice((notice) => notices.push(notice));
    const asked = bridge.ask({ kind: 'hello' }, 50);
    deliver({ source: SOURCE, kind: 'context', id: 1, theme: 'dark', selection }, { other: true });
    deliver({ source: SOURCE, kind: 'theme', theme: 'light' }, { other: true });
    deliver({ source: SOURCE, kind: 'theme', theme: 'purple' });
    await expect(asked).rejects.toThrow('Penpot did not answer');
    deliver({ source: SOURCE, kind: 'theme', theme: 'light' });
    expect(notices).toEqual([{ source: SOURCE, kind: 'theme', theme: 'light' }]);
  });

  it('times out when Penpot never answers', async () => {
    vi.useFakeTimers();
    const { win } = fakeWindow();
    const asked = createBridge(win).ask({ kind: 'hello' });
    vi.advanceTimersByTime(120_000);
    await expect(asked).rejects.toBeInstanceOf(PluginError);
    vi.useRealTimers();
  });
});

describe('the key store and the theme', () => {
  it('keeps a real key in storage and forgets it on clear', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    } as unknown as Storage;
    const keys = keyStore(storage);
    expect(keys.get()).toBeNull();
    keys.set(KEY);
    expect(data.get('converter-studio.penpot.api-key')).toBe(KEY);
    expect(keyStore(storage).get()).toBe(KEY);
    keys.clear();
    expect(keys.get()).toBeNull();
    expect(data.size).toBe(0);
  });

  it('falls back to memory when storage refuses', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const keys = keyStore(storage);
    keys.set(KEY);
    expect(keys.get()).toBe(KEY);
    keys.clear();
    expect(keys.get()).toBeNull();
    expect(keyStore(null).get()).toBeNull();
  });

  it('knows a key when it sees one', () => {
    expect(isApiKey(KEY)).toBe(true);
    expect(isApiKey(`${KEY}x`)).toBe(false);
    expect(isApiKey('cvs_test_abc')).toBe(false);
  });

  it('reads the theme Penpot opened the panel with', () => {
    expect(themeFromLocation({ search: '', hash: '#/?theme=light' })).toBe('light');
    expect(themeFromLocation({ search: '?theme=light', hash: '' })).toBe('light');
    expect(themeFromLocation({ search: '', hash: '#/?theme=dark' })).toBe('dark');
    expect(themeFromLocation({ search: '?theme=blue', hash: '' })).toBe('dark');
    expect(themeFromLocation({ search: '', hash: '' })).toBe('dark');
  });
});
