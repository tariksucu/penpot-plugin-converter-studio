import type { Penpot } from '@penpot/plugin-types';

/**
 * Penpot's plugin API in memory: the parts the plugin's code calls, with Penpot's semantics
 * (the frontend's src/app/plugins/*.cljs and the runtime's api/index.ts): new layers start on the
 * page's root at 0,0 and 100 × 100; `appendChild` moves a layer into a board; `x` and `y` are
 * page coordinates; an uploaded image reports its size; `export` returns bytes.
 */

export class FakeShape {
  name: string;
  x = 0;
  y = 0;
  width: number;
  height: number;
  parent: FakeShape | null = null;
  readonly children: FakeShape[] = [];
  fills: unknown[] = [];
  proportionLock = false;
  readonly exports: unknown[] = [];

  constructor(
    readonly id: string,
    readonly type: string,
    name: string,
    size: { width: number; height: number } = { width: 100, height: 100 },
  ) {
    this.name = name;
    this.width = size.width;
    this.height = size.height;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  appendChild(child: FakeShape) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  }

  export(config: { type: string; scale?: number }): Promise<Uint8Array> {
    this.exports.push(config);
    return Promise.resolve(new Uint8Array(config.type === 'pdf' ? [37, 80, 68, 70] : [137, 80]));
  }
}

export interface FakeOptions {
  readonly theme?: 'light' | 'dark';
  /** The image size `uploadMediaData` reports. */
  readonly imageSize?: { width: number; height: number };
  /** `uploadMediaData` rejects with this. */
  readonly uploadError?: unknown;
  /** `createShapeFromSvgWithImages` resolves to `null` (Penpot could not read it). */
  readonly svgFails?: boolean;
  readonly viewport?: { x: number; y: number; width: number; height: number };
}

export function fakePenpot(options: FakeOptions = {}) {
  let next = 1;
  const root = new FakeShape('00000000-0000-0000-0000-000000000000', 'board', 'Root');
  const shapes = new Map<string, FakeShape>();
  const add = (shape: FakeShape, parent: FakeShape = root) => {
    shapes.set(shape.id, shape);
    parent.appendChild(shape);
    return shape;
  };
  const board = (name: string, box: { x: number; y: number; width: number; height: number }) => {
    const shape = add(new FakeShape(`board-${next++}`, 'board', name, box));
    shape.x = box.x;
    shape.y = box.y;
    return shape;
  };

  const sent: unknown[] = [];
  const listeners = new Map<string, (value: unknown) => void>();
  const undo: string[] = [];
  const uploads: Array<{ name: string; bytes: Uint8Array; mime: string }> = [];
  const svgs: string[] = [];
  let onMessage: ((message: unknown) => void) | null = null;
  let selection: FakeShape[] = [];
  const opened: unknown[] = [];

  const penpot = {
    ui: {
      open: (...args: unknown[]) => opened.push(args),
      sendMessage: (message: unknown) => sent.push(structuredClone(message)),
      onMessage: (callback: (message: unknown) => void) => (onMessage = callback),
    },
    on: (type: string, callback: (value: unknown) => void) => {
      listeners.set(type, callback);
      return Symbol(type);
    },
    theme: options.theme ?? 'dark',
    get selection() {
      return selection;
    },
    set selection(value: FakeShape[]) {
      selection = value;
    },
    root,
    currentPage: { getShapeById: (id: string) => shapes.get(id) ?? null },
    viewport: { bounds: options.viewport ?? { x: 1000, y: 2000, width: 1600, height: 900 } },
    history: {
      undoBlockBegin: () => {
        undo.push('begin');
        return Symbol('block');
      },
      undoBlockFinish: () => undo.push('finish'),
    },
    utils: { types: { isBoard: (shape: FakeShape) => shape.type === 'board' } },
    uploadMediaData: (name: string, bytes: Uint8Array, mime: string) => {
      if (options.uploadError) return Promise.reject(options.uploadError);
      uploads.push({ name, bytes, mime });
      const size = options.imageSize ?? { width: 4032, height: 3024 };
      return Promise.resolve({ id: `media-${next++}`, name, mtype: mime, ...size });
    },
    createRectangle: () => add(new FakeShape(`rect-${next++}`, 'rectangle', 'Rectangle')),
    createShapeFromSvgWithImages: (svg: string) => {
      svgs.push(svg);
      if (options.svgFails) return Promise.resolve(null);
      return Promise.resolve(
        add(new FakeShape(`group-${next++}`, 'group', 'svg', { width: 640, height: 480 })),
      );
    },
  };

  return {
    penpot: penpot as unknown as Penpot,
    root,
    board,
    add,
    shapes,
    sent,
    listeners,
    undo,
    uploads,
    svgs,
    opened,
    select: (...picked: FakeShape[]) => (selection = picked),
    /** A message from the panel. */
    receive: (message: unknown) => onMessage?.(message),
  };
}
