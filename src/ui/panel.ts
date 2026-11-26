import { ApiError, type Account, type ConverterApi, type FormatInfo } from './api';
import { PluginError, type Bridge } from './bridge';
import {
  COMPRESSIONS,
  Catalog,
  DEFAULT_EXPORT,
  DEFAULT_IMPORT,
  ICON_SIZES,
  IMPORT_SOURCES,
  LONG_SIDES,
  MAX_KB,
  MIN_KB,
  PDF_DPIS,
  PENPOT_NATIVE,
  QUALITIES,
  SCALES,
  exportFields,
  exportOptions,
  exportScale,
  fileName,
  formatBytes,
  importOptions,
  isImageType,
  layerName,
  type Compression,
  type ExportSettings,
  type ExportTarget,
  type IconSize,
  type ImportSettings,
  type ImportTarget,
  type LongSide,
  type PdfDpi,
  type Quality,
} from './choices';
import { AUTO_CONFIRM_CREDITS, runConversion, type Step } from './convert';
import { externalLink, h, select, show } from './dom';
import { isApiKey, type KeyStore } from './key-store';
import { applyTheme } from './theme';
import {
  MAX_EXPORTS,
  MAX_IMAGE_BYTES,
  MAX_SVG_CHARS,
  type LayerInfo,
  type SelectionState,
} from '../shared/messages';

/**
 * The plugin's panel: connect a Converter Studio account (an API key), then either place a file
 * Penpot cannot open on the selected board, or export the selected layers to a format Penpot
 * does not export.
 */

export const SITE = 'https://converter.studio';
export const LINKS = {
  apiKeys: `${SITE}/account#api-keys`,
  pricing: `${SITE}/pricing`,
  privacy: `${SITE}/privacy`,
  help: 'https://github.com/tariksucu/penpot-plugin-converter-studio#readme',
};

export interface PanelDeps {
  readonly bridge: Bridge;
  readonly keys: KeyStore;
  /** The API with an account's key ('' for what needs none: the formats). */
  readonly api: (key: string) => ConverterApi;
  /** The page's `<html>`, for the theme. */
  readonly root: HTMLElement;
}

type Tab = 'place' | 'export';

interface Picked {
  readonly file: File;
  readonly format: FormatInfo | undefined;
}

interface ExportRow {
  readonly name: string;
  readonly state: 'waiting' | 'working' | 'done' | 'failed';
  readonly note: string;
  readonly downloadUrl?: string;
}

interface State {
  catalog: Catalog | null;
  api: ConverterApi | null;
  account: Account | null;
  selection: SelectionState;
  tab: Tab;
  picked: Picked | null;
  importTarget: ImportTarget | null;
  importSettings: ImportSettings;
  exportTarget: ExportTarget | null;
  exportSettings: ExportSettings;
  exportRows: ExportRow[];
  busy: AbortController | null;
}

const EMPTY_SELECTION: SelectionState = {
  layers: [],
  count: 0,
  destination: { kind: 'page', name: null },
};

const SIZE_LABELS: Readonly<Record<LongSide, string>> = {
  '2560': 'Up to 2560 px',
  '1920': 'Up to 1920 px',
  '1280': 'Up to 1280 px',
  '800': 'Up to 800 px',
  original: 'Original size',
};
const DPI_LABELS: Readonly<Record<PdfDpi, string>> = {
  '150': '150 DPI (screen)',
  '300': '300 DPI (print)',
  '72': '72 DPI (small)',
};
const QUALITY_LABELS: Readonly<Record<Quality, string>> = {
  high: 'High quality',
  balanced: 'Balanced',
  small: 'Smallest file',
  lossless: 'Lossless (logos, UI)',
};
const ICON_LABELS: Readonly<Record<IconSize, string>> = {
  favicon: 'Favicon (16, 32 and 48 px)',
  '256': '256 px',
  '128': '128 px',
  '64': '64 px',
  '48': '48 px',
  '32': '32 px',
  '16': '16 px',
};
const COMPRESSION_LABELS: Readonly<Record<Compression, string>> = {
  balanced: 'Balanced',
  strong: 'Strong (smallest)',
  light: 'Light (best quality)',
};

export async function startPanel(container: HTMLElement, deps: PanelDeps): Promise<void> {
  const { bridge, keys } = deps;
  const state: State = {
    catalog: null,
    api: null,
    account: null,
    selection: EMPTY_SELECTION,
    tab: 'place',
    picked: null,
    importTarget: null,
    importSettings: DEFAULT_IMPORT,
    exportTarget: null,
    exportSettings: DEFAULT_EXPORT,
    exportRows: [],
    busy: null,
  };

  const header = h('header', { class: 'bar' });
  const body = h('main', { class: 'body' });
  const footer = h(
    'footer',
    { class: 'foot' },
    externalLink(LINKS.help, 'Help'),
    externalLink(LINKS.pricing, 'Plans and credits'),
    externalLink(LINKS.privacy, 'Privacy'),
  );
  container.replaceChildren(header, body, footer);

  bridge.onNotice((notice) => {
    if (notice.kind === 'theme') applyTheme(deps.root, notice.theme);
    else {
      state.selection = notice.selection;
      // While something runs, the panel keeps showing it; the new selection shows after.
      if (!state.busy && state.api) render();
    }
  });

  // ── Header ─────────────────────────────────────────────────────────────────────────────

  function renderHeader() {
    // Penpot's own title bar above says "Converter Studio"; this line says whose credits.
    const brand = h(
      'a',
      {
        class: 'brand',
        href: SITE,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Converter Studio',
      },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', { class: 'brand-name', text: 'converter.studio' }),
    );
    if (!state.account) {
      show(header, brand, h('span', { class: 'credits', text: 'Not connected' }));
      return;
    }
    const disconnect = h('button', { type: 'button', class: 'link-button', text: 'Disconnect' });
    disconnect.addEventListener('click', () => {
      state.busy?.abort();
      keys.clear();
      renderConnect();
    });
    show(
      header,
      brand,
      h(
        'div',
        { class: 'account' },
        h('span', {
          class: 'credits',
          title: state.account.email,
          text: `${state.account.credits.toLocaleString('en-US')} credit${state.account.credits === 1 ? '' : 's'}`,
        }),
        disconnect,
      ),
    );
  }

  async function refreshAccount() {
    if (!state.api) return;
    try {
      state.account = await state.api.account();
      renderHeader();
    } catch {
      // The header keeps the last count.
    }
  }

  // ── Connect ────────────────────────────────────────────────────────────────────────────

  function renderConnect(error: string | null = null) {
    state.api = null;
    state.account = null;
    renderHeader();
    const input = h('input', {
      id: 'api-key',
      type: 'password',
      class: 'input',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'cvs_live_…',
      'aria-describedby': 'key-help',
    });
    const message = h('p', { class: 'message error', role: 'alert' });
    if (error) message.textContent = error;
    const button = h('button', { type: 'submit', class: 'button primary', text: 'Connect' });
    const form = h(
      'form',
      { class: 'stack', novalidate: true },
      h('h1', { class: 'title', text: 'Connect your Converter Studio account' }),
      h('p', {
        class: 'muted',
        id: 'key-help',
        text: 'Place HEIC, RAW, AVIF, TIFF, EPS, AI and PDF files on a board, and export layers as AVIF, WebP, JPG, TIFF, ICO or a smaller PDF. Conversions use your Converter Studio credits: 25 free a day, more with a paid plan.',
      }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'api-key', class: 'label', text: 'API key' }),
        input,
      ),
      button,
      message,
      h(
        'p',
        { class: 'muted small' },
        'No key yet? ',
        externalLink(LINKS.apiKeys, 'Create one on your account page'),
        '. The key is kept in this browser for the plugin only.',
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!isApiKey(key)) {
        message.textContent =
          'That does not look like a Converter Studio API key (it starts with cvs_live_).';
        input.focus();
        return;
      }
      button.disabled = true;
      message.textContent = '';
      void connect(key).then((problem) => {
        if (problem) {
          button.disabled = false;
          message.textContent = problem;
        }
      });
    });
    // No focus() here: a frame may not take focus before the user does something.
    show(body, form);
  }

  /** Checks the key with the API; on success saves it and opens the tabs. */
  async function connect(key: string): Promise<string | null> {
    const api = deps.api(key);
    try {
      const account = await api.account();
      keys.set(key);
      state.api = api;
      state.account = account;
      render();
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────

  function render() {
    renderHeader();
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    for (const [tab, label] of [
      ['place', 'Place a file'],
      ['export', 'Export selection'],
    ] as const) {
      const button = h('button', {
        type: 'button',
        role: 'tab',
        class: 'tab',
        id: `tab-${tab}`,
        'aria-selected': state.tab === tab ? 'true' : 'false',
        text: label,
      });
      button.disabled = state.busy !== null;
      button.addEventListener('click', () => {
        state.tab = tab;
        render();
      });
      tabs.appendChild(button);
    }
    const panel = h('section', { class: 'stack', role: 'tabpanel' });
    if (state.tab === 'place') renderPlace(panel);
    else renderExport(panel);
    show(body, tabs, panel);
  }

  // ── Place a file ───────────────────────────────────────────────────────────────────────

  function destinationText(): string {
    const destination = state.selection.destination;
    return destination.kind === 'board'
      ? `Goes into the board “${destination.name ?? 'Board'}”, scaled to fit.`
      : 'Goes onto the page, in the middle of your view. Select a board to place it there.';
  }

  function renderPlace(panel: HTMLElement) {
    const catalog = state.catalog!;
    const input = h('input', {
      id: 'file',
      type: 'file',
      class: 'file-input',
      accept: catalog.acceptList(),
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) pick(file);
    });
    const drop = h(
      'label',
      { for: 'file', class: 'drop' },
      h('span', {
        class: 'drop-title',
        text: state.picked ? 'Choose another file' : 'Choose a file',
      }),
      h('span', {
        class: 'muted small',
        text: 'HEIC, camera RAW, AVIF, TIFF, BMP, EPS, AI or PDF. Or drop it here.',
      }),
    );
    for (const type of ['dragover', 'dragenter'] as const)
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('over');
      });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('over');
      const file = event.dataTransfer?.files[0];
      if (file) pick(file);
    });
    panel.append(input, drop);

    const picked = state.picked;
    if (!picked) {
      panel.append(h('p', { class: 'muted small', text: destinationText() }));
      return;
    }
    panel.append(
      h(
        'p',
        { class: 'picked' },
        h('strong', { text: picked.file.name }),
        ` · ${formatBytes(picked.file.size)}`,
        picked.format ? ` · ${picked.format.name}` : '',
      ),
    );
    const format = picked.format;
    if (format && PENPOT_NATIVE.has(format.id)) {
      panel.append(
        h('p', {
          class: 'message',
          text: `Penpot places ${format.name} files itself: drag the file onto the canvas.`,
        }),
      );
      return;
    }
    const targets = catalog.importTargets(format);
    if (!format || targets.length === 0) {
      panel.append(
        h('p', {
          class: 'message error',
          role: 'alert',
          text: 'Converter Studio cannot place this kind of file in Penpot.',
        }),
      );
      return;
    }
    const maxBytes = state.account?.maxFileBytes ?? 0;
    if (maxBytes > 0 && picked.file.size > maxBytes) {
      panel.append(
        h(
          'p',
          { class: 'message error', role: 'alert' },
          `This file is ${formatBytes(picked.file.size)}; your plan takes files up to ${formatBytes(maxBytes)}. `,
          externalLink(LINKS.pricing, 'See the plans'),
        ),
      );
      return;
    }
    const target =
      state.importTarget && targets.includes(state.importTarget) ? state.importTarget : targets[0]!;
    state.importTarget = target;
    panel.append(
      select(
        'import-target',
        'Place it as',
        targets.map((t) => [t.id, t.label] as const),
        target.id,
        (id) => {
          state.importTarget = targets.find((t) => t.id === id) ?? null;
          render();
        },
      ),
    );
    const group = IMPORT_SOURCES[format.id];
    if (group === 'photo')
      panel.append(
        select(
          'import-size',
          'Size',
          LONG_SIDES.map((s) => [s, SIZE_LABELS[s]] as const),
          state.importSettings.longSide,
          (longSide) => (state.importSettings = { ...state.importSettings, longSide }),
        ),
      );
    if (group === 'pdf') {
      const page = h('input', {
        id: 'import-page',
        type: 'number',
        class: 'input',
        min: 1,
        max: 99999,
        step: 1,
        value: state.importSettings.page,
      });
      page.addEventListener('change', () => {
        const value = Number(page.value);
        state.importSettings = {
          ...state.importSettings,
          page: Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1,
        };
      });
      panel.append(
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'import-page', class: 'label', text: 'Page' }),
          page,
        ),
        select(
          'import-dpi',
          'Resolution',
          PDF_DPIS.map((d) => [d, DPI_LABELS[d]] as const),
          state.importSettings.dpi,
          (dpi) => (state.importSettings = { ...state.importSettings, dpi }),
        ),
      );
    }
    const status = h('p', { class: 'message', role: 'status', 'aria-live': 'polite' });
    const button = h('button', {
      type: 'button',
      class: 'button primary',
      text: 'Convert and place',
    });
    button.addEventListener('click', () => void place(format, target, status, button));
    panel.append(h('p', { class: 'muted small', text: destinationText() }), button, status);
  }

  function pick(file: File) {
    state.picked = { file, format: state.catalog?.formatOfName(file.name) };
    state.importTarget = null;
    state.importSettings = { ...state.importSettings, page: 1 };
    render();
  }

  async function place(
    format: FormatInfo,
    target: ImportTarget,
    status: HTMLElement,
    button: HTMLButtonElement,
  ) {
    const picked = state.picked;
    if (!picked || !state.api) return;
    const run = begin(button, status);
    try {
      const finished = await runConversion(
        state.api,
        {
          file: picked.file,
          name: picked.file.name,
          to: target.id,
          options: importOptions(format, target, state.importSettings),
        },
        {
          signal: run.signal,
          onStep: (step) => (status.textContent = stepText(step)),
          confirmPrice: (credits) => confirmPrice(status, credits),
        },
      );
      if (target.kind === 'image' && finished.size > MAX_IMAGE_BYTES)
        throw tooLargeForPenpot(finished.size);
      status.textContent = 'Downloading the result…';
      const blob = await state.api.download(finished.downloadUrl, run.signal);
      status.textContent = 'Placing it in Penpot…';
      const name = layerName(picked.file.name);
      let reply;
      if (target.kind === 'svg') {
        const svg = await blob.text();
        if (svg.length > MAX_SVG_CHARS)
          throw new ApiError('tooLarge', 'The SVG is too large for Penpot. Place it as PNG.', 0);
        reply = await bridge.ask({ kind: 'place-svg', name, svg });
      } else {
        if (blob.size > MAX_IMAGE_BYTES) throw tooLargeForPenpot(blob.size);
        if (!isImageType(target.mime)) throw new ApiError('invalidRequest', 'Not a picture.', 0);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        reply = await bridge.ask({ kind: 'place-image', name, bytes, mime: target.mime });
      }
      if (reply.kind !== 'placed') throw new PluginError('Penpot did not place the file.');
      const where =
        reply.destination.kind === 'board'
          ? `in the board “${reply.destination.name ?? 'Board'}”`
          : 'on the page';
      end();
      state.picked = null;
      render();
      showDone(`Placed “${reply.name}” ${where}. ${creditsText(finished.credits)}`);
    } catch (error) {
      end();
      render();
      showError(messageOf(error));
    }
  }

  // ── Export selection ───────────────────────────────────────────────────────────────────

  function renderExport(panel: HTMLElement) {
    const catalog = state.catalog!;
    const targets = catalog.exportTargets();
    const layers = state.selection.layers;
    if (layers.length === 0) {
      panel.append(
        h('p', {
          class: 'muted',
          text: 'Select one or more layers or boards in Penpot to export them.',
        }),
      );
    } else {
      const names = layers.slice(0, MAX_EXPORTS).map((layer) => layer.name);
      panel.append(
        h(
          'p',
          { class: 'picked' },
          h('strong', {
            text: `${state.selection.count} layer${state.selection.count === 1 ? '' : 's'} selected`,
          }),
          `: ${names.join(', ')}`,
          state.selection.count > MAX_EXPORTS ? ` (the first ${MAX_EXPORTS} are exported)` : '',
        ),
      );
    }
    if (targets.length === 0) {
      panel.append(
        h('p', { class: 'message error', text: 'Exports are not available right now.' }),
      );
      return;
    }
    const target =
      state.exportTarget && targets.includes(state.exportTarget) ? state.exportTarget : targets[0]!;
    state.exportTarget = target;
    const fields = exportFields(target);
    const settings = state.exportSettings;
    const set = (change: Partial<ExportSettings>) =>
      (state.exportSettings = { ...state.exportSettings, ...change });
    panel.append(
      select(
        'export-target',
        'Format',
        targets.map((t) => [t.id, t.label] as const),
        target.id,
        (id) => {
          state.exportTarget = targets.find((t) => t.id === id) ?? null;
          render();
        },
      ),
      h('p', { class: 'muted small', text: target.hint }),
    );
    if (fields.scale)
      panel.append(
        select(
          'export-scale',
          'Scale',
          SCALES.map((s) => [String(s), `${s}×`] as const),
          String(settings.scale),
          (scale) => set({ scale: Number(scale) }),
        ),
      );
    if (fields.quality) {
      const qualities = QUALITIES.filter((q) => q !== 'lossless' || fields.lossless);
      panel.append(
        select(
          'export-quality',
          'Quality',
          qualities.map((q) => [q, QUALITY_LABELS[q]] as const),
          qualities.includes(settings.quality) ? settings.quality : 'high',
          (quality) => {
            set({ quality });
            render();
          },
        ),
      );
    }
    if (fields.maxKb && !(fields.lossless && settings.quality === 'lossless')) {
      const input = h('input', {
        id: 'export-max-kb',
        type: 'number',
        class: 'input',
        min: MIN_KB,
        max: MAX_KB,
        step: 1,
        placeholder: 'No limit',
        value: settings.maxKb ?? '',
      });
      input.addEventListener('change', () => {
        const value = Number(input.value);
        set({ maxKb: input.value.trim() && Number.isFinite(value) && value > 0 ? value : null });
      });
      panel.append(
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'export-max-kb', class: 'label', text: 'At most (KB)' }),
          input,
        ),
      );
    }
    if (fields.iconSize)
      panel.append(
        select(
          'export-icon',
          'Icon size',
          ICON_SIZES.map((s) => [s, ICON_LABELS[s]] as const),
          settings.iconSize,
          (iconSize) => set({ iconSize }),
        ),
      );
    if (fields.compression)
      panel.append(
        select(
          'export-compression',
          'Compression',
          COMPRESSIONS.map((c) => [c, COMPRESSION_LABELS[c]] as const),
          settings.compression,
          (compression) => set({ compression }),
        ),
      );
    const status = h('p', { class: 'message', role: 'status', 'aria-live': 'polite' });
    const count = Math.min(layers.length, MAX_EXPORTS);
    const button = h('button', {
      type: 'button',
      class: 'button primary',
      text: count > 1 ? `Export ${count} layers` : 'Export',
    });
    button.disabled = count === 0;
    button.addEventListener(
      'click',
      () => void exportLayers(layers.slice(0, MAX_EXPORTS), target, status, button),
    );
    panel.append(button, status, exportList());
  }

  function exportList(): HTMLElement {
    const list = h('ul', { class: 'results' });
    for (const row of state.exportRows) {
      const item = h(
        'li',
        { class: `result ${row.state}` },
        h('span', { class: 'result-name', text: row.name }),
        h('span', { class: 'muted small', text: row.note }),
      );
      if (row.downloadUrl)
        item.appendChild(
          h('a', {
            class: 'button small',
            href: row.downloadUrl,
            download: row.name,
            text: 'Download',
          }),
        );
      list.appendChild(item);
    }
    if (state.exportRows.some((row) => row.downloadUrl))
      list.appendChild(h('li', { class: 'muted small', text: 'Download links work for 6 hours.' }));
    return list;
  }

  async function exportLayers(
    layers: readonly LayerInfo[],
    target: ExportTarget,
    status: HTMLElement,
    button: HTMLButtonElement,
  ) {
    if (!state.api || layers.length === 0) return;
    const settings = state.exportSettings;
    const options = exportOptions(target, settings);
    state.exportRows = layers.map((layer) => ({
      name: fileName(layer.name, target.extension),
      state: 'waiting',
      note: 'Waiting',
    }));
    const list = exportList();
    status.after(list);
    const run = begin(button, status);
    const update = (index: number, row: Partial<ExportRow>) => {
      state.exportRows[index] = { ...state.exportRows[index]!, ...row };
      list.replaceWith(exportList());
    };
    let spent = 0;
    try {
      for (const [index, layer] of layers.entries()) {
        if (run.signal.aborted) break;
        const name = fileName(layer.name, target.extension);
        try {
          update(index, { state: 'working', note: `Exporting from Penpot…` });
          const exported = await bridge.ask({
            kind: 'export',
            layerId: layer.id,
            type: target.penpot,
            scale: exportScale(target, settings, layer),
          });
          if (exported.kind !== 'exported') throw new PluginError('Penpot exported nothing.');
          const file = new Blob([exported.bytes as Uint8Array<ArrayBuffer>], {
            type: target.penpot === 'pdf' ? 'application/pdf' : 'image/png',
          });
          const finished = await runConversion(
            state.api,
            { file, name: fileName(layer.name, target.source), to: target.to, options },
            {
              signal: run.signal,
              onStep: (step) => update(index, { note: stepText(step) }),
              confirmPrice: (credits) => confirmPrice(status, credits),
            },
          );
          spent += finished.credits;
          update(index, {
            state: 'done',
            note: `${formatBytes(finished.size)} · ${creditsText(finished.credits)}`,
            downloadUrl: finished.downloadUrl,
          });
        } catch (error) {
          update(index, { name, state: 'failed', note: messageOf(error) });
          if (error instanceof ApiError && STOPS.has(error.code)) break;
        }
      }
    } finally {
      end();
      render();
      const done = state.exportRows.filter((row) => row.state === 'done').length;
      if (done > 0) showDone(`${done} file${done === 1 ? '' : 's'} ready. ${creditsText(spent)}`);
    }
  }

  // ── Running ────────────────────────────────────────────────────────────────────────────

  /** Disables the tabs, turns `button` into Cancel and returns the run's abort signal. */
  function begin(button: HTMLButtonElement, status: HTMLElement): AbortController {
    const run = new AbortController();
    state.busy = run;
    for (const tab of body.querySelectorAll<HTMLButtonElement>('.tab')) tab.disabled = true;
    // The last run's outcome goes; this run's shows in `status`.
    for (const old of body.querySelectorAll('.message.error, .message.done'))
      if (old !== status) old.remove();
    const cancel = h('button', { type: 'button', class: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => {
      run.abort();
      cancel.disabled = true;
    });
    button.replaceWith(cancel);
    status.textContent = 'Starting…';
    return run;
  }

  function end() {
    state.busy = null;
    void refreshAccount();
  }

  /** Asks before a conversion dearer than `AUTO_CONFIRM_CREDITS`. */
  function confirmPrice(status: HTMLElement, credits: number): Promise<boolean> {
    return new Promise((resolve) => {
      const yes = h('button', {
        type: 'button',
        class: 'button primary small',
        text: `Use ${credits} credits`,
      });
      const no = h('button', { type: 'button', class: 'button small', text: 'Don’t convert' });
      const box = h(
        'div',
        { class: 'confirm', role: 'alertdialog', 'aria-label': 'Confirm the price' },
        h('p', {
          text: `This conversion costs ${credits} credits (more than ${AUTO_CONFIRM_CREDITS}). Go ahead?`,
        }),
        h('div', { class: 'row' }, yes, no),
      );
      const answer = (value: boolean) => {
        box.remove();
        resolve(value);
      };
      yes.addEventListener('click', () => answer(true));
      no.addEventListener('click', () => answer(false));
      // Cancel (or Disconnect) while the question is open answers it.
      state.busy?.signal.addEventListener('abort', () => answer(false), { once: true });
      status.after(box);
      yes.focus();
    });
  }

  function showDone(text: string) {
    const status =
      body.querySelector('[role="status"]') ?? body.appendChild(h('p', { class: 'message' }));
    status.className = 'message done';
    status.textContent = text;
  }

  function showError(text: string) {
    const target = body.querySelector('section') ?? body;
    target.appendChild(h('p', { class: 'message error', role: 'alert', text }));
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────

  renderHeader();
  show(body, h('p', { class: 'muted', text: 'Loading…' }));
  try {
    const [formats, context] = await Promise.all([
      deps.api('').formats(),
      bridge.ask({ kind: 'hello' }, 10_000).catch(() => null),
    ]);
    state.catalog = new Catalog(formats);
    if (context?.kind === 'context') {
      applyTheme(deps.root, context.theme);
      state.selection = context.selection;
    }
  } catch (error) {
    const retry = h('button', { type: 'button', class: 'button', text: 'Try again' });
    retry.addEventListener('click', () => void startPanel(container, deps));
    show(body, h('p', { class: 'message error', role: 'alert', text: messageOf(error) }), retry);
    return;
  }
  const saved = keys.get();
  if (!saved) {
    renderConnect();
    return;
  }
  show(body, h('p', { class: 'muted', text: 'Connecting…' }));
  const problem = await connect(saved);
  if (problem) {
    // A deleted or mistyped key: forget it.
    if (/key/i.test(problem)) keys.clear();
    renderConnect(problem);
  }
}

/** Errors after which the next layer would fail the same way. */
const STOPS = new Set(['canceled', 'invalidApiKey', 'insufficientCredits', 'network', 'timeout']);

function stepText(step: Step): string {
  if (step.step === 'uploading')
    return step.total > 0 && step.sent < step.total
      ? `Uploading… ${Math.round((step.sent / step.total) * 100)}%`
      : 'Uploading…';
  if (step.status === 'quoted') return 'Waiting for your go-ahead…';
  if (step.status === 'processing' && step.progress !== null)
    return `Converting… ${Math.round(step.progress * 100)}%`;
  return 'Converting…';
}

function creditsText(credits: number): string {
  return `${credits} credit${credits === 1 ? '' : 's'} used.`;
}

function tooLargeForPenpot(size: number): ApiError {
  return new ApiError(
    'tooLargeForPenpot',
    `The picture is ${formatBytes(size)}; Penpot takes images up to ${formatBytes(MAX_IMAGE_BYTES)}. Choose a smaller size, or WebP.`,
    0,
  );
}

/** What the user reads: the API's own `errorMessage`, Penpot's reason, or a plain sentence. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError || error instanceof PluginError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Canceled.';
  return 'Something went wrong. Try again.';
}
