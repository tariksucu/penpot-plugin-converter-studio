/**
 * Where a placed file goes and how big it is: plain geometry, no Penpot API (unit tested).
 *
 * A file goes into the selected board (or the board around the selected layer), centred and
 * scaled down to fit it; with no board, onto the page in the middle of the view, within 80% of
 * what is on screen. It is never scaled up: Penpot keeps the image's full resolution either
 * way, so a large photo stays sharp when the layer is enlarged later.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How much of the visible canvas a file placed on the page may cover at most. */
export const VIEW_SHARE = 0.8;

const round = (value: number) => Math.round(value * 100) / 100;

/** `width` × `height` scaled down (never up) to fit inside `max`, proportions kept. */
export function fitInside(size: Size, max: Size): Size {
  const width = size.width > 0 ? size.width : 1;
  const height = size.height > 0 ? size.height : 1;
  const scale = Math.min(
    1,
    max.width > 0 ? max.width / width : 1,
    max.height > 0 ? max.height / height : 1,
  );
  return { width: Math.max(1, round(width * scale)), height: Math.max(1, round(height * scale)) };
}

/** The top-left corner that centres `size` in `box`. */
export function centerIn(box: Box, size: Size): { x: number; y: number } {
  return {
    x: round(box.x + (box.width - size.width) / 2),
    y: round(box.y + (box.height - size.height) / 2),
  };
}

/** The part of the visible canvas a file placed on the page may cover. */
export function viewArea(bounds: Box): Box {
  const width = bounds.width * VIEW_SHARE;
  const height = bounds.height * VIEW_SHARE;
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}
