import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  MAX_NAME,
  SOURCE,
  cleanName,
  parsePluginMessage,
  parseRequest,
} from '../src/shared/messages';
import { centerIn, fitInside, viewArea } from '../src/plugin/place';

const selection = {
  count: 1,
  layers: [{ id: 'b1', name: 'Hero', type: 'board', width: 10, height: 20 }],
  destination: { kind: 'board', name: 'Hero' },
};

describe('the messages between panel and plugin', () => {
  it('takes well-formed requests and drops the rest', () => {
    const bytes = new Uint8Array([1]);
    expect(parseRequest({ source: SOURCE, kind: 'hello', id: 1 })).toEqual({
      source: SOURCE,
      kind: 'hello',
      id: 1,
    });
    expect(
      parseRequest({
        source: SOURCE,
        kind: 'place-image',
        id: 2,
        name: 'a',
        bytes,
        mime: 'image/jpeg',
      }),
    ).toMatchObject({ kind: 'place-image', name: 'a', mime: 'image/jpeg' });
    for (const bad of [
      null,
      'hello',
      [],
      { kind: 'hello', id: 1 },
      { source: 'other', kind: 'hello', id: 1 },
      { source: SOURCE, kind: 'hello', id: 0 },
      { source: SOURCE, kind: 'hello', id: 1.5 },
      { source: SOURCE, kind: 'nope', id: 1 },
      { source: SOURCE, kind: 'place-image', id: 2, name: '', bytes, mime: 'image/png' },
      {
        source: SOURCE,
        kind: 'place-image',
        id: 2,
        name: 'a',
        bytes: new Uint8Array(),
        mime: 'image/png',
      },
      { source: SOURCE, kind: 'place-image', id: 2, name: 'a', bytes: [1], mime: 'image/png' },
      { source: SOURCE, kind: 'place-image', id: 2, name: 'a', bytes, mime: 'image/svg+xml' },
      { source: SOURCE, kind: 'place-svg', id: 3, name: 'a', svg: 'not an svg' },
      { source: SOURCE, kind: 'export', id: 4, layerId: '', type: 'png', scale: 1 },
      { source: SOURCE, kind: 'export', id: 4, layerId: 'a', type: 'jpeg', scale: 1 },
      { source: SOURCE, kind: 'export', id: 4, layerId: 'a', type: 'png', scale: 0 },
      { source: SOURCE, kind: 'export', id: 4, layerId: 'a', type: 'png', scale: 17 },
    ])
      expect(parseRequest(bad)).toBeNull();
  });

  it('refuses a picture over Penpot’s upload limit', () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    expect(
      parseRequest({
        source: SOURCE,
        kind: 'place-image',
        id: 1,
        name: 'a',
        bytes: big,
        mime: 'image/png',
      }),
    ).toBeNull();
  });

  it('cleans names: control characters out, never empty, cut to length', () => {
    expect(cleanName('a\u0000b\nc')).toBe('a b c');
    expect(cleanName('   ')).toBe('Converted');
    expect(cleanName('x'.repeat(500))).toHaveLength(MAX_NAME);
    expect(
      parseRequest({ source: SOURCE, kind: 'place-svg', id: 1, name: ' logo\t', svg: '<svg/>' }),
    ).toMatchObject({ name: 'logo' });
    expect(
      parseRequest({ source: SOURCE, kind: 'place-svg', id: 1, name: 'a', svg: '<svgx>' }),
    ).toBeNull();
  });

  it('takes the plugin’s replies and notices, well formed only', () => {
    expect(parsePluginMessage({ source: SOURCE, kind: 'theme', theme: 'light' })).toEqual({
      source: SOURCE,
      kind: 'theme',
      theme: 'light',
    });
    expect(parsePluginMessage({ source: SOURCE, kind: 'selection', selection })).toMatchObject({
      selection: { count: 1, destination: { kind: 'board', name: 'Hero' } },
    });
    expect(
      parsePluginMessage({ source: SOURCE, kind: 'context', id: 1, theme: 'dark', selection }),
    ).toMatchObject({ kind: 'context', id: 1 });
    expect(
      parsePluginMessage({
        source: SOURCE,
        kind: 'exported',
        id: 2,
        name: 'Hero',
        bytes: new Uint8Array([1]),
      }),
    ).toMatchObject({ kind: 'exported', name: 'Hero' });
    expect(
      parsePluginMessage({ source: SOURCE, kind: 'failed', id: 3, message: '' }),
    ).toMatchObject({
      message: 'Penpot could not do that.',
    });
    for (const bad of [
      { kind: 'theme', theme: 'light' },
      { source: SOURCE, kind: 'theme', theme: 'blue' },
      { source: SOURCE, kind: 'selection', selection: { ...selection, layers: [{ id: 1 }] } },
      {
        source: SOURCE,
        kind: 'selection',
        selection: { ...selection, destination: { kind: 'x' } },
      },
      { source: SOURCE, kind: 'exported', id: 2, name: 'Hero', bytes: 'abc' },
      { source: SOURCE, kind: 'placed', id: 2, name: 'a', destination: null },
      { source: SOURCE, kind: 'context', id: 1, theme: 'dark' },
    ])
      expect(parsePluginMessage(bad)).toBeNull();
  });
});

describe('placement geometry', () => {
  it('fits a size inside a box, never larger, proportions kept', () => {
    expect(fitInside({ width: 4000, height: 3000 }, { width: 1000, height: 1000 })).toEqual({
      width: 1000,
      height: 750,
    });
    expect(fitInside({ width: 100, height: 50 }, { width: 1000, height: 1000 })).toEqual({
      width: 100,
      height: 50,
    });
    expect(fitInside({ width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({
      width: 1,
      height: 1,
    });
    expect(fitInside({ width: 1000, height: 3 }, { width: 10, height: 10 })).toEqual({
      width: 10,
      height: 1,
    });
  });

  it('centres in a box and takes 80% of the view', () => {
    expect(centerIn({ x: 10, y: 20, width: 100, height: 100 }, { width: 50, height: 20 })).toEqual({
      x: 35,
      y: 60,
    });
    expect(viewArea({ x: 0, y: 0, width: 1000, height: 500 })).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 400,
    });
  });
});
