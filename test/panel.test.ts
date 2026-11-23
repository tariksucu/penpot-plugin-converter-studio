// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConverterApi } from '../src/ui/api';
import { PluginError, type Ask, type Bridge } from '../src/ui/bridge';
import { keyStore } from '../src/ui/key-store';
import { startPanel } from '../src/ui/panel';
import { SOURCE, type Notice, type SelectionState } from '../src/shared/messages';
import { BASE, KEY, fakeServer, type Scenario } from './fake-server';

// The fake server's answers are Node's; keep files and blobs Node's too (jsdom has its own).
vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);

const BOARD: SelectionState = {
  count: 1,
  layers: [{ id: 'b1', name: 'Hero', type: 'board', width: 1440, height: 900 }],
  destination: { kind: 'board', name: 'Hero' },
};
const NOTHING: SelectionState = { count: 0, layers: [], destination: { kind: 'page', name: null } };

/** The plugin's side, as the panel sees it through the bridge. */
function fakeBridge(selection: SelectionState, fail: string | null = null) {
  const asked: Ask[] = [];
  let notify: ((notice: Notice) => void) | null = null;
  const bridge: Bridge = {
    ask(request) {
      asked.push(request);
      if (fail && request.kind !== 'hello') return Promise.reject(new PluginError(fail));
      switch (request.kind) {
        case 'hello':
          return Promise.resolve({
            source: SOURCE,
            kind: 'context',
            id: 1,
            theme: 'light',
            selection,
          });
        case 'place-image':
        case 'place-svg':
          return Promise.resolve({
            source: SOURCE,
            kind: 'placed',
            id: 2,
            name: request.name,
            destination: selection.destination,
          });
        case 'export':
          return Promise.resolve({
            source: SOURCE,
            kind: 'exported',
            id: 3,
            name: 'Hero',
            bytes: new Uint8Array([137, 80, 78, 71]),
          });
      }
    },
    onNotice: (listener) => (notify = listener),
  };
  return { bridge, asked, notice: (n: Notice) => notify?.(n) };
}

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.dataset.theme = 'dark';
  container = document.createElement('div');
  document.body.appendChild(container);
  localStorage.clear();
});

async function open(
  options: {
    scenario?: Partial<Scenario>;
    key?: string | null;
    selection?: SelectionState;
    fail?: string;
  } = {},
) {
  const server = fakeServer(options.scenario);
  const plugin = fakeBridge(options.selection ?? BOARD, options.fail ?? null);
  const keys = keyStore(localStorage);
  if (options.key !== null) keys.set(options.key ?? KEY);
  await startPanel(container, {
    bridge: plugin.bridge,
    keys,
    api: (k) => new ConverterApi(BASE, k, server.fetch),
    root: document.documentElement,
  });
  return { server, plugin, keys };
}

const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
const until = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 10 });

function choose(name: string, bytes: Uint8Array = new Uint8Array(100)) {
  const input = container.querySelector<HTMLInputElement>('#file')!;
  const file = new NodeFile([bytes], name) as unknown as File;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

describe('connecting', () => {
  it('checks the key with the API and shows its error, then connects', async () => {
    const { keys } = await open({ key: null });
    expect(text()).toContain('Connect your Converter Studio account');
    // Penpot's theme from the plugin's hello.
    expect(document.documentElement.dataset.theme).toBe('light');
    const form = () => container.querySelector('form')!;
    const input = () => container.querySelector<HTMLInputElement>('#api-key')!;

    input().value = 'my password';
    form().dispatchEvent(new Event('submit', { cancelable: true }));
    expect(text()).toContain('That does not look like a Converter Studio API key');

    input().value = `cvs_live_${'b'.repeat(32)}`;
    form().dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => expect(text()).toContain('This API key does not work.'));
    expect(keys.get()).toBeNull();

    input().value = KEY;
    form().dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => expect(text()).toContain('12 credits'));
    expect(keys.get()).toBe(KEY);
    expect(text()).toContain('Place a file');
  });

  it('forgets a saved key the API no longer takes', async () => {
    const { keys } = await open({ key: `cvs_live_${'c'.repeat(32)}` });
    expect(text()).toContain('This API key does not work.');
    expect(keys.get()).toBeNull();
  });

  it('disconnects: the key is deleted', async () => {
    const { keys } = await open();
    await until(() => expect(text()).toContain('Disconnect'));
    button('Disconnect').click();
    expect(keys.get()).toBeNull();
    expect(text()).toContain('Connect your Converter Studio account');
  });

  it('follows Penpot’s theme changes', async () => {
    const { plugin } = await open();
    plugin.notice({ source: SOURCE, kind: 'theme', theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('placing a file', () => {
  it('converts a HEIC photo and hands the WebP to the plugin for the selected board', async () => {
    const output = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
    const { server, plugin } = await open({ scenario: { output } });
    expect(text()).toContain('Goes into the board “Hero”');
    choose('IMG_0042.HEIC');
    expect(text()).toContain('IMG_0042.HEIC');
    expect(container.querySelector<HTMLSelectElement>('#import-target')!.value).toBe('webp');
    button('Convert and place').click();
    await until(() =>
      expect(text()).toContain('Placed “IMG_0042” in the board “Hero”. 1 credit used.'),
    );
    const placed = plugin.asked.find((a) => a.kind === 'place-image');
    expect(placed).toEqual({
      kind: 'place-image',
      name: 'IMG_0042',
      bytes: output,
      mime: 'image/webp',
    });
    const convert = server.requests.find((r) => r.url.endsWith('/v1/conversions'))!;
    expect(convert.body).toMatchObject({
      to: 'webp',
      options: { longSide: '2560', quality: 'high' },
    });
  });

  it('places an EPS as editable SVG layers', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
    const { plugin } = await open({
      scenario: { output: new TextEncoder().encode(svg) },
      selection: NOTHING,
    });
    choose('logo.eps');
    expect(container.querySelector<HTMLSelectElement>('#import-target')!.value).toBe('svg');
    button('Convert and place').click();
    await until(() => expect(text()).toContain('Placed “logo” on the page.'));
    expect(plugin.asked.find((a) => a.kind === 'place-svg')).toEqual({
      kind: 'place-svg',
      name: 'logo',
      svg,
    });
  });

  it('sends a PDF page with its number and resolution', async () => {
    const { server } = await open();
    choose('brochure.pdf');
    const page = container.querySelector<HTMLInputElement>('#import-page')!;
    page.value = '4';
    page.dispatchEvent(new Event('change'));
    button('Convert and place').click();
    await until(() => expect(text()).toContain('Placed “brochure”'));
    const convert = server.requests.find((r) => r.url.endsWith('/v1/conversions'))!;
    expect(convert.body).toMatchObject({ to: 'png', options: { pageRange: '4', dpi: '150' } });
  });

  it('says when Penpot places a file itself, and when nothing can be done', async () => {
    const { server } = await open();
    choose('photo.png');
    expect(text()).toContain('Penpot places PNG files itself');
    choose('report.docx');
    expect(text()).toContain('Converter Studio cannot place this kind of file in Penpot.');
    expect(server.requests.some((r) => r.url.endsWith('/v1/uploads'))).toBe(false);
  });

  it('shows the API’s message when a conversion fails', async () => {
    await open({
      scenario: { fail: { code: 'conversionFailed', message: 'This file is not a HEIC photo.' } },
    });
    choose('broken.heic');
    button('Convert and place').click();
    await until(() => expect(text()).toContain('This file is not a HEIC photo.'));
    expect(button('Convert and place')).toBeTruthy();
  });

  it('shows Penpot’s reason when the plugin cannot place the file', async () => {
    await open({ fail: 'The file is read-only' });
    choose('IMG_1.heic');
    button('Convert and place').click();
    await until(() => expect(text()).toContain('The file is read-only'));
  });

  it('asks before a dearer conversion', async () => {
    const { server } = await open({ scenario: { credits: 5 } });
    choose('scan.tiff');
    button('Convert and place').click();
    await until(() => expect(text()).toContain('This conversion costs 5 credits'));
    button('Don’t convert').click();
    await until(() => expect(text()).toContain('Canceled. Nothing was charged.'));
    expect(server.requests.some((r) => r.url.endsWith('/confirm'))).toBe(false);

    // Cancel while the question is open answers it too.
    button('Convert and place').click();
    await until(() => expect(text()).toContain('This conversion costs 5 credits'));
    button('Cancel').click();
    await until(() => expect(text()).toContain('Canceled. Nothing was charged.'));
    expect(text()).not.toContain('This conversion costs');

    button('Convert and place').click();
    await until(() => expect(text()).toContain('This conversion costs 5 credits'));
    button('Use 5 credits').click();
    await until(() => expect(text()).toContain('Placed “scan”'));
    expect(server.requests.some((r) => r.url.endsWith('/confirm'))).toBe(true);
  });
});

describe('exporting the selection', () => {
  it('exports the selected board from Penpot and converts it to AVIF with a download link', async () => {
    const { server, plugin } = await open({ scenario: { output: new Uint8Array(2048) } });
    button('Export selection').click();
    expect(text()).toContain('1 layer selected: Hero');
    expect(container.querySelector<HTMLSelectElement>('#export-target')!.value).toBe('avif');
    const scale = container.querySelector<HTMLSelectElement>('#export-scale')!;
    scale.value = '2';
    scale.dispatchEvent(new Event('change'));
    button('Export').click();
    await until(() => expect(text()).toContain('1 file ready. 1 credit used.'));
    expect(plugin.asked.find((a) => a.kind === 'export')).toEqual({
      kind: 'export',
      layerId: 'b1',
      type: 'png',
      scale: 2,
    });
    const upload = server.requests.find((r) => r.url.endsWith('/v1/uploads'))!;
    expect(upload.body).toEqual({ fileName: 'Hero.png', size: 4 });
    const link = container.querySelector<HTMLAnchorElement>('a[download]')!;
    expect(link.getAttribute('download')).toBe('Hero.avif');
    expect(link.href).toMatch(`${BASE}/jobs/`);
    expect(text()).toContain('2 KB');
  });

  it('exports a smaller PDF through Penpot’s PDF export', async () => {
    const { server, plugin } = await open();
    button('Export selection').click();
    const format = container.querySelector<HTMLSelectElement>('#export-target')!;
    format.value = 'pdf';
    format.dispatchEvent(new Event('change'));
    expect(container.querySelector('#export-scale')).toBeNull();
    button('Export').click();
    await until(() => expect(text()).toContain('1 file ready'));
    expect(plugin.asked.find((a) => a.kind === 'export')).toMatchObject({ type: 'pdf' });
    const convert = server.requests.find((r) => r.url.endsWith('/v1/conversions'))!;
    expect(convert.body).toMatchObject({ to: 'pdf', options: { compression: 'balanced' } });
  });

  it('asks for a selection when nothing is selected, and follows selection changes', async () => {
    const { plugin } = await open({ selection: NOTHING });
    button('Export selection').click();
    expect(text()).toContain('Select one or more layers or boards in Penpot');
    expect(button('Export').disabled).toBe(true);
    plugin.notice({ source: SOURCE, kind: 'selection', selection: BOARD });
    expect(text()).toContain('1 layer selected: Hero');
    expect(button('Export').disabled).toBe(false);
  });

  it('marks a layer that fails and says why', async () => {
    await open({ fail: 'That layer is no longer on this page. Select it again.' });
    button('Export selection').click();
    button('Export').click();
    await until(() =>
      expect(text()).toContain('That layer is no longer on this page. Select it again.'),
    );
    expect(container.querySelector('a[download]')).toBeNull();
  });
});
