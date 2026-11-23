import type { Board, Penpot, Shape } from '@penpot/plugin-types';
import {
  MAX_SELECTION,
  SOURCE,
  parseRequest,
  type Destination,
  type PluginMessage,
  type Reply,
  type Request,
  type SelectionState,
} from '../shared/messages';
import { centerIn, fitInside, viewArea, type Box } from './place';

/**
 * The plugin's code inside Penpot (it runs in Penpot's sandbox, with the `penpot` object and no
 * network, DOM or storage). It opens the panel (src/ui, served next to the manifest), tells it
 * the theme and the selection, and does what only Penpot can: put a converted file on a board,
 * and export a layer for the panel to convert. Everything that talks to Converter Studio
 * happens in the panel.
 *
 * Permissions (manifest.json): `content:read` (selection, theme events, exports) and
 * `content:write` (upload an image to the file, create layers). `allow:downloads` is the
 * panel's, for saving an export.
 */

export const PANEL = { width: 320, height: 640 } as const;

export function startPlugin(penpot: Penpot): void {
  // Relative to the manifest (manifest version 2): the panel lives next to it.
  penpot.ui.open('Converter Studio', 'index.html', PANEL);
  const send = (message: PluginMessage) => penpot.ui.sendMessage(message);
  penpot.on('themechange', (theme) => send({ source: SOURCE, kind: 'theme', theme }));
  penpot.on('selectionchange', () =>
    send({ source: SOURCE, kind: 'selection', selection: selectionState(penpot) }),
  );
  penpot.ui.onMessage((raw: unknown) => {
    const request = parseRequest(raw);
    // Not ours, or not well formed: nothing to answer.
    if (!request) return;
    void answer(penpot, request).then(send);
  });
}

/** What the panel asked for, done; errors become a `failed` reply with Penpot's reason. */
export async function answer(penpot: Penpot, request: Request): Promise<Reply> {
  try {
    switch (request.kind) {
      case 'hello':
        return {
          source: SOURCE,
          kind: 'context',
          id: request.id,
          theme: penpot.theme,
          selection: selectionState(penpot),
        };
      case 'place-image': {
        const placed = await placeImage(penpot, request.name, request.bytes, request.mime);
        return { source: SOURCE, kind: 'placed', id: request.id, ...placed };
      }
      case 'place-svg': {
        const placed = await placeSvg(penpot, request.name, request.svg);
        return { source: SOURCE, kind: 'placed', id: request.id, ...placed };
      }
      case 'export': {
        const layer = penpot.currentPage?.getShapeById(request.layerId) ?? null;
        if (!layer) throw new Error('That layer is no longer on this page. Select it again.');
        const bytes = await layer.export({
          type: request.type,
          ...(request.type === 'png' ? { scale: request.scale } : {}),
        });
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
          throw new Error('Penpot exported nothing for this layer.');
        return { source: SOURCE, kind: 'exported', id: request.id, name: layer.name, bytes };
      }
    }
  } catch (error) {
    return { source: SOURCE, kind: 'failed', id: request.id, message: reason(error) };
  }
}

/** The selected layers, and where a placed file would go. */
export function selectionState(penpot: Penpot): SelectionState {
  const selection = penpot.selection;
  const board = targetBoard(penpot);
  return {
    count: selection.length,
    layers: selection.slice(0, MAX_SELECTION).map((shape) => ({
      id: shape.id,
      name: shape.name,
      type: shape.type,
      width: shape.width,
      height: shape.height,
    })),
    destination: board ? { kind: 'board', name: board.name } : { kind: 'page', name: null },
  };
}

/**
 * The board a file goes into: the selected board, or the nearest board around the first
 * selected layer. `null` when nothing is selected or the layer sits on the page itself.
 */
export function targetBoard(penpot: Penpot): Board | null {
  const rootId = penpot.root?.id;
  let shape: Shape | null = penpot.selection[0] ?? null;
  // A board inside a board inside…: a few levels are plenty, and a loop cannot run away.
  for (let depth = 0; shape && depth < 64; depth++) {
    if (shape.id === rootId) return null;
    if (penpot.utils.types.isBoard(shape)) return shape;
    shape = shape.parent;
  }
  return null;
}

interface Placed {
  readonly name: string;
  readonly destination: Destination;
}

/** The box a new layer is fitted into and centred in. */
function areaFor(penpot: Penpot, board: Board | null): Box {
  if (board) return { x: board.x, y: board.y, width: board.width, height: board.height };
  return viewArea(penpot.viewport.bounds);
}

/** Moves `shape` into the board (or onto the page), fits it, centres it and selects it. */
function settle(penpot: Penpot, shape: Shape, board: Board | null, name: string): Placed {
  shape.name = name;
  if (board) {
    board.appendChild(shape);
  } else {
    // New layers start on the page, but an SVG may land in a board at the page's origin.
    const root = penpot.root;
    if (root && shape.parent?.id !== root.id && penpot.utils.types.isBoard(root))
      root.appendChild(shape);
  }
  const size = fitInside(shape, areaFor(penpot, board));
  if (size.width !== shape.width || size.height !== shape.height)
    shape.resize(size.width, size.height);
  const at = centerIn(areaFor(penpot, board), size);
  shape.x = at.x;
  shape.y = at.y;
  penpot.selection = [shape];
  return {
    name,
    destination: board ? { kind: 'board', name: board.name } : { kind: 'page', name: null },
  };
}

/** A raster image as a rectangle filled with it, like an image dropped onto the canvas. */
async function placeImage(
  penpot: Penpot,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<Placed> {
  const board = targetBoard(penpot);
  // The upload changes nothing on the canvas; the layer is made after it, in one undo step.
  const image = await penpot.uploadMediaData(name, bytes, mime);
  const block = penpot.history.undoBlockBegin();
  try {
    const rect = penpot.createRectangle();
    rect.resize(Math.max(1, image.width), Math.max(1, image.height));
    rect.fills = [{ fillOpacity: 1, fillImage: image }];
    rect.proportionLock = true;
    return settle(penpot, rect, board, name);
  } finally {
    penpot.history.undoBlockFinish(block);
  }
}

/** An SVG as editable layers (a group), with any pictures inside it uploaded to the file. */
async function placeSvg(penpot: Penpot, name: string, svg: string): Promise<Placed> {
  const board = targetBoard(penpot);
  const block = penpot.history.undoBlockBegin();
  try {
    const group = await penpot.createShapeFromSvgWithImages(svg);
    if (!group) throw new Error('Penpot could not read the SVG.');
    return settle(penpot, group, board, name);
  } finally {
    penpot.history.undoBlockFinish(block);
  }
}

/** Penpot rejects with an `Error` or, in older releases, a plain string. */
function reason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Penpot could not do that.';
}
