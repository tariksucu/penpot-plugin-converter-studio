/**
 * The messages between the plugin's code inside Penpot (src/plugin: `penpot.ui.onMessage`,
 * `penpot.ui.sendMessage`) and its panel, an iframe served from converter.studio (src/ui:
 * `parent.postMessage`, the window's `message` event).
 *
 * Penpot hands a message to a plugin only when it comes from that plugin's own iframe, and the
 * panel reads messages from its parent window only. Each side still checks every message's
 * shape on arrival (`parseRequest`, `parsePluginMessage`) and ignores what does not fit: a
 * message is data, never code.
 */

/** Marks our messages, so anything else that reaches a window is ignored. */
export const SOURCE = 'converter-studio';

/** The image types Penpot stores and the panel hands over (Penpot also takes GIF and SVG). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * Penpot's default limit for one uploaded image (`media-max-file-size`, 30 MiB). A self-hosted
 * instance may set another; Penpot then refuses the upload with its own error.
 */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** The longest SVG the panel hands over, in characters. */
export const MAX_SVG_CHARS = 20_000_000;
/** Penpot's export scale: any positive number; the panel asks for 1 to 16. */
export const MAX_EXPORT_SCALE = 16;
/** Layer names are cut to this length on the way. */
export const MAX_NAME = 200;
/** The most selected layers the plugin describes (an export takes up to `MAX_EXPORTS`). */
export const MAX_SELECTION = 50;
export const MAX_EXPORTS = 10;

export type Theme = 'light' | 'dark';

/** A selected layer, as the panel sees it. */
export interface LayerInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/** Where a placed file goes: a board, or the page in the middle of the view. */
export interface Destination {
  readonly kind: 'board' | 'page';
  /** The board's name (`kind: 'board'`). */
  readonly name: string | null;
}

export interface SelectionState {
  readonly layers: readonly LayerInfo[];
  /** How many layers are selected (more than `layers` holds when over `MAX_SELECTION`). */
  readonly count: number;
  readonly destination: Destination;
}

// ── Panel → plugin ────────────────────────────────────────────────────────────────────────

export type Request =
  /** The panel has loaded: answered with `context`. */
  | { readonly source: typeof SOURCE; readonly kind: 'hello'; readonly id: number }
  /** A raster image to put on the board (or page) as a rectangle filled with it. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'place-image';
      readonly id: number;
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly mime: ImageType;
    }
  /** An SVG to turn into editable Penpot layers. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'place-svg';
      readonly id: number;
      readonly name: string;
      readonly svg: string;
    }
  /** Penpot's own export of one layer, for the panel to convert. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'export';
      readonly id: number;
      readonly layerId: string;
      readonly type: 'png' | 'pdf';
      readonly scale: number;
    };

// ── Plugin → panel ────────────────────────────────────────────────────────────────────────

export type Reply =
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'context';
      readonly id: number;
      readonly theme: Theme;
      readonly selection: SelectionState;
    }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'placed';
      readonly id: number;
      readonly name: string;
      readonly destination: Destination;
    }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'exported';
      readonly id: number;
      readonly name: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'failed';
      readonly id: number;
      readonly message: string;
    };

/** What the plugin tells the panel unasked. */
export type Notice =
  | { readonly source: typeof SOURCE; readonly kind: 'theme'; readonly theme: Theme }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'selection';
      readonly selection: SelectionState;
    };

export type PluginMessage = Reply | Notice;

// ── Checks ────────────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A file or layer name, cut to `MAX_NAME` characters, never empty. */
export function cleanName(name: string, fallback = 'Converted'): string {
  // Control characters out; Penpot shows the rest as it is.
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (clean || fallback).slice(0, MAX_NAME);
}

/** A message from the panel, or `null` when it is not one of ours or not well formed. */
export function parseRequest(value: unknown): Request | null {
  if (!isObject(value) || value.source !== SOURCE || !isId(value.id)) return null;
  switch (value.kind) {
    case 'hello':
      return { source: SOURCE, kind: 'hello', id: value.id };
    case 'place-image':
      if (!isText(value.name, MAX_NAME * 2)) return null;
      if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0) return null;
      if (value.bytes.byteLength > MAX_IMAGE_BYTES) return null;
      if (!IMAGE_TYPES.includes(value.mime as ImageType)) return null;
      return {
        source: SOURCE,
        kind: 'place-image',
        id: value.id,
        name: cleanName(value.name),
        bytes: value.bytes,
        mime: value.mime as ImageType,
      };
    case 'place-svg':
      if (!isText(value.name, MAX_NAME * 2) || !isText(value.svg, MAX_SVG_CHARS)) return null;
      if (!/<svg[\s/>]/i.test(value.svg.slice(0, 4096))) return null;
      return {
        source: SOURCE,
        kind: 'place-svg',
        id: value.id,
        name: cleanName(value.name),
        svg: value.svg,
      };
    case 'export':
      if (!isText(value.layerId, 100)) return null;
      if (value.type !== 'png' && value.type !== 'pdf') return null;
      if (typeof value.scale !== 'number' || !(value.scale > 0 && value.scale <= MAX_EXPORT_SCALE))
        return null;
      return {
        source: SOURCE,
        kind: 'export',
        id: value.id,
        layerId: value.layerId,
        type: value.type,
        scale: value.scale,
      };
    default:
      return null;
  }
}

function parseSelection(value: unknown): SelectionState | null {
  if (!isObject(value) || !Array.isArray(value.layers) || !isSize(value.count)) return null;
  const destination = value.destination;
  if (!isObject(destination) || (destination.kind !== 'board' && destination.kind !== 'page'))
    return null;
  const layers: LayerInfo[] = [];
  for (const layer of value.layers.slice(0, MAX_SELECTION)) {
    if (!isObject(layer) || !isText(layer.id, 100) || typeof layer.name !== 'string') return null;
    if (typeof layer.type !== 'string' || !isSize(layer.width) || !isSize(layer.height))
      return null;
    layers.push({
      id: layer.id,
      name: cleanName(layer.name, 'Layer'),
      type: layer.type,
      width: layer.width,
      height: layer.height,
    });
  }
  return {
    layers,
    count: value.count,
    destination: {
      kind: destination.kind,
      name: typeof destination.name === 'string' ? cleanName(destination.name, 'Board') : null,
    },
  };
}

/** A message from the plugin, or `null`. */
export function parsePluginMessage(value: unknown): PluginMessage | null {
  if (!isObject(value) || value.source !== SOURCE) return null;
  switch (value.kind) {
    case 'theme':
      return isTheme(value.theme) ? { source: SOURCE, kind: 'theme', theme: value.theme } : null;
    case 'selection': {
      const selection = parseSelection(value.selection);
      return selection ? { source: SOURCE, kind: 'selection', selection } : null;
    }
    case 'context': {
      const selection = parseSelection(value.selection);
      if (!isId(value.id) || !isTheme(value.theme) || !selection) return null;
      return { source: SOURCE, kind: 'context', id: value.id, theme: value.theme, selection };
    }
    case 'placed': {
      const destination = value.destination;
      if (!isId(value.id) || typeof value.name !== 'string' || !isObject(destination)) return null;
      if (destination.kind !== 'board' && destination.kind !== 'page') return null;
      return {
        source: SOURCE,
        kind: 'placed',
        id: value.id,
        name: cleanName(value.name),
        destination: {
          kind: destination.kind,
          name: typeof destination.name === 'string' ? cleanName(destination.name, 'Board') : null,
        },
      };
    }
    case 'exported':
      if (!isId(value.id) || typeof value.name !== 'string') return null;
      if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0) return null;
      return {
        source: SOURCE,
        kind: 'exported',
        id: value.id,
        name: cleanName(value.name, 'Layer'),
        bytes: value.bytes,
      };
    case 'failed':
      if (!isId(value.id) || typeof value.message !== 'string') return null;
      return {
        source: SOURCE,
        kind: 'failed',
        id: value.id,
        message: value.message.slice(0, 500) || 'Penpot could not do that.',
      };
    default:
      return null;
  }
}
