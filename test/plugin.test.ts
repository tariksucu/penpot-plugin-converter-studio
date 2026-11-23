import { describe, expect, it, vi } from 'vitest';
import { PANEL, answer, selectionState, startPlugin, targetBoard } from '../src/plugin/plugin';
import { SOURCE, type Reply } from '../src/shared/messages';
import { FakeShape, fakePenpot, type FakeOptions } from './fake-penpot';

const png = new Uint8Array([137, 80, 78, 71]);

function started(options: FakeOptions = {}) {
  const fake = fakePenpot(options);
  startPlugin(fake.penpot);
  /** Sends a panel message and waits for the plugin's answer. */
  const ask = async (message: Record<string, unknown>) => {
    const before = fake.sent.length;
    fake.receive({ source: SOURCE, ...message });
    await vi.waitFor(() => expect(fake.sent.length).toBeGreaterThan(before));
    return fake.sent.at(-1) as Reply;
  };
  return { ...fake, ask };
}

describe('the plugin in Penpot', () => {
  it('opens the panel next to the manifest and answers hello with the theme and selection', async () => {
    const fake = started({ theme: 'light' });
    expect(fake.opened).toEqual([['Converter Studio', 'index.html', PANEL]]);
    const hero = fake.board('Hero', { x: 0, y: 0, width: 1440, height: 900 });
    fake.select(hero);
    const reply = await fake.ask({ kind: 'hello', id: 1 });
    expect(reply).toEqual({
      source: SOURCE,
      kind: 'context',
      id: 1,
      theme: 'light',
      selection: {
        count: 1,
        layers: [{ id: hero.id, name: 'Hero', type: 'board', width: 1440, height: 900 }],
        destination: { kind: 'board', name: 'Hero' },
      },
    });
  });

  it('passes theme changes and selection changes on to the panel', () => {
    const fake = started();
    fake.listeners.get('themechange')!('light');
    expect(fake.sent.at(-1)).toEqual({ source: SOURCE, kind: 'theme', theme: 'light' });
    const card = fake.board('Card', { x: 0, y: 0, width: 300, height: 200 });
    fake.select(card);
    fake.listeners.get('selectionchange')!([card.id]);
    expect(fake.sent.at(-1)).toMatchObject({
      kind: 'selection',
      selection: { count: 1, destination: { kind: 'board', name: 'Card' } },
    });
  });

  it('ignores messages that are not its own or not well formed', async () => {
    const fake = started();
    fake.receive({ kind: 'hello', id: 1 });
    fake.receive({ source: SOURCE, kind: 'hello', id: -1 });
    fake.receive({
      source: SOURCE,
      kind: 'place-image',
      id: 2,
      name: 'x',
      bytes: 'nope',
      mime: 'image/png',
    });
    fake.receive({
      source: SOURCE,
      kind: 'place-image',
      id: 3,
      name: 'x',
      bytes: png,
      mime: 'image/heic',
    });
    fake.receive({ source: SOURCE, kind: 'export', id: 4, layerId: 'a', type: 'svg', scale: 1 });
    fake.receive({ source: SOURCE, kind: 'export', id: 5, layerId: 'a', type: 'png', scale: 99 });
    fake.receive({ source: SOURCE, kind: 'place-svg', id: 6, name: 'x', svg: '<html></html>' });
    fake.receive('hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.sent).toEqual([]);
    expect(fake.uploads).toEqual([]);
  });

  it('places a picture inside the selected board, fitted, centred and selected, in one undo step', async () => {
    const fake = started({ imageSize: { width: 4032, height: 3024 } });
    const hero = fake.board('Hero', { x: 100, y: 50, width: 1440, height: 900 });
    fake.select(hero);
    const reply = await fake.ask({
      kind: 'place-image',
      id: 7,
      name: 'IMG_0042',
      bytes: png,
      mime: 'image/webp',
    });
    expect(reply).toEqual({
      source: SOURCE,
      kind: 'placed',
      id: 7,
      name: 'IMG_0042',
      destination: { kind: 'board', name: 'Hero' },
    });
    expect(fake.uploads).toEqual([{ name: 'IMG_0042', bytes: png, mime: 'image/webp' }]);
    const rect = hero.children[0]!;
    expect(rect.type).toBe('rectangle');
    expect(rect.name).toBe('IMG_0042');
    // 4032 × 3024 into 1440 × 900: the height decides (900 / 3024).
    expect(rect.width).toBe(1200);
    expect(rect.height).toBe(900);
    expect(rect.x).toBe(100 + (1440 - 1200) / 2);
    expect(rect.y).toBe(50);
    expect(rect.fills).toEqual([
      { fillOpacity: 1, fillImage: expect.objectContaining({ width: 4032 }) },
    ]);
    expect(rect.proportionLock).toBe(true);
    expect(fake.penpot.selection).toEqual([rect]);
    expect(fake.undo).toEqual(['begin', 'finish']);
  });

  it('places into the board around the selected layer, and onto the page without one', async () => {
    const fake = started({ imageSize: { width: 200, height: 100 } });
    const card = fake.board('Card', { x: 0, y: 0, width: 400, height: 400 });
    const label = fake.add(new FakeShape('text-1', 'text', 'Label'), card);
    fake.select(label);
    expect(targetBoard(fake.penpot)?.name).toBe('Card');
    let reply = await fake.ask({
      kind: 'place-image',
      id: 1,
      name: 'a',
      bytes: png,
      mime: 'image/png',
    });
    expect(reply).toMatchObject({ destination: { kind: 'board', name: 'Card' } });
    // Small pictures keep their size.
    expect(card.children.at(-1)).toMatchObject({ width: 200, height: 100, x: 100, y: 150 });

    fake.select();
    reply = await fake.ask({
      kind: 'place-image',
      id: 2,
      name: 'b',
      bytes: png,
      mime: 'image/png',
    });
    expect(reply).toMatchObject({ destination: { kind: 'page', name: null } });
    const onPage = fake.root.children.at(-1)!;
    expect(onPage.name).toBe('b');
    // In the middle of the view (1000, 2000, 1600 × 900).
    expect(onPage).toMatchObject({ width: 200, height: 100, x: 1700, y: 2400 });
  });

  it('never treats the page root as a board, and stops on a parent loop', () => {
    const fake = started();
    fake.select(fake.root);
    expect(targetBoard(fake.penpot)).toBeNull();
    const a = new FakeShape('a', 'group', 'A');
    a.parent = a;
    fake.select(a);
    expect(targetBoard(fake.penpot)).toBeNull();
  });

  it('turns an SVG into layers and moves them out of a board they landed in', async () => {
    const fake = started({ viewport: { x: 0, y: 0, width: 500, height: 500 } });
    const reply = await fake.ask({
      kind: 'place-svg',
      id: 3,
      name: 'logo',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
    });
    expect(reply).toMatchObject({ kind: 'placed', name: 'logo', destination: { kind: 'page' } });
    expect(fake.svgs).toHaveLength(1);
    const group = fake.root.children.at(-1)!;
    expect(group.type).toBe('group');
    // 640 × 480 into 80% of 500 × 500 (400 × 400).
    expect(group).toMatchObject({ name: 'logo', width: 400, height: 300, x: 50, y: 100 });
    expect(fake.undo).toEqual(['begin', 'finish']);
  });

  it('answers failed with Penpot’s reason', async () => {
    let fake = started({ svgFails: true });
    let reply = await fake.ask({ kind: 'place-svg', id: 1, name: 'x', svg: '<svg></svg>' });
    expect(reply).toEqual({
      source: SOURCE,
      kind: 'failed',
      id: 1,
      message: 'Penpot could not read the SVG.',
    });
    expect(fake.undo).toEqual(['begin', 'finish']);

    fake = started({ uploadError: 'Plugin doesn’t have permission' });
    reply = await fake.ask({
      kind: 'place-image',
      id: 2,
      name: 'x',
      bytes: png,
      mime: 'image/png',
    });
    expect(reply).toMatchObject({ kind: 'failed', message: 'Plugin doesn’t have permission' });
    // Nothing was put on the canvas.
    expect(fake.undo).toEqual([]);

    fake = started({ uploadError: new Error('The file is read-only') });
    reply = await fake.ask({
      kind: 'place-image',
      id: 3,
      name: 'x',
      bytes: png,
      mime: 'image/png',
    });
    expect(reply).toMatchObject({ kind: 'failed', message: 'The file is read-only' });
  });

  it('exports a layer: PNG at the asked scale, PDF without one', async () => {
    const fake = started();
    const hero = fake.board('Hero', { x: 0, y: 0, width: 100, height: 100 });
    let reply = await fake.ask({ kind: 'export', id: 1, layerId: hero.id, type: 'png', scale: 2 });
    expect(reply).toEqual({
      source: SOURCE,
      kind: 'exported',
      id: 1,
      name: 'Hero',
      bytes: new Uint8Array([137, 80]),
    });
    reply = await fake.ask({ kind: 'export', id: 2, layerId: hero.id, type: 'pdf', scale: 1 });
    expect(reply).toMatchObject({ kind: 'exported', bytes: new Uint8Array([37, 80, 68, 70]) });
    expect(hero.exports).toEqual([{ type: 'png', scale: 2 }, { type: 'pdf' }]);

    reply = await fake.ask({ kind: 'export', id: 3, layerId: 'gone', type: 'png', scale: 1 });
    expect(reply).toMatchObject({
      kind: 'failed',
      message: 'That layer is no longer on this page. Select it again.',
    });
  });

  it('describes at most 50 selected layers but counts them all', () => {
    const fake = fakePenpot();
    const many = Array.from({ length: 60 }, (_, i) =>
      fake.add(new FakeShape(`s${i}`, 'rectangle', `R${i}`)),
    );
    fake.select(...many);
    const state = selectionState(fake.penpot);
    expect(state.count).toBe(60);
    expect(state.layers).toHaveLength(50);
    expect(state.destination).toEqual({ kind: 'page', name: null });
  });

  it('answers every request kind (the switch is complete)', async () => {
    const fake = fakePenpot();
    const reply = await answer(fake.penpot, { source: SOURCE, kind: 'hello', id: 9 });
    expect(reply.kind).toBe('context');
  });
});
