import { describe, expect, it } from 'vitest';
import {
  Catalog,
  DEFAULT_EXPORT,
  DEFAULT_IMPORT,
  EXPORT_TARGETS,
  PENPOT_NATIVE,
  exportFields,
  exportOptions,
  exportScale,
  fileName,
  importOptions,
  layerName,
} from '../src/ui/choices';
import type { FormatInfo } from '../src/ui/api';
import { FORMATS } from './fake-server';

const catalog = new Catalog(FORMATS);
const format = (id: string) => catalog.get(id)!;
const ids = (list: Array<{ id: string }>) => list.map((t) => t.id);

describe('what the plugin places', () => {
  it('offers pictures for photos, editable vectors for drawings and pictures for a PDF page', () => {
    expect(ids(catalog.importTargets(format('heic')))).toEqual(['webp', 'png', 'jpg']);
    expect(ids(catalog.importTargets(format('dng')))).toEqual(['webp', 'png', 'jpg']);
    expect(ids(catalog.importTargets(format('avif')))).toEqual(['webp', 'png', 'jpg']);
    expect(ids(catalog.importTargets(format('tiff')))).toEqual(['webp', 'png', 'jpg']);
    expect(ids(catalog.importTargets(format('eps')))).toEqual(['svg', 'png']);
    expect(ids(catalog.importTargets(format('ai')))).toEqual(['svg', 'png']);
    expect(ids(catalog.importTargets(format('pdf')))).toEqual(['png', 'jpg', 'webp']);
  });

  it('offers nothing for what Penpot places itself, or for files that are not pictures', () => {
    for (const id of ['png', 'jpg', 'webp', 'gif', 'svg']) {
      expect(PENPOT_NATIVE.has(id)).toBe(true);
      expect(catalog.importTargets(format(id))).toEqual([]);
    }
    expect(catalog.importTargets(format('docx'))).toEqual([]);
    expect(catalog.importTargets(format('mp4'))).toEqual([]);
    expect(catalog.importTargets(undefined)).toEqual([]);
  });

  it('only offers what the server can do now', () => {
    const limited: FormatInfo[] = [{ ...format('eps'), to: ['png'] }];
    expect(ids(new Catalog(limited).importTargets(limited[0]))).toEqual(['png']);
  });

  it('finds formats by extension and lists the picker’s extensions', () => {
    expect(catalog.formatOfName('IMG_0042.HEIC')?.id).toBe('heic');
    expect(catalog.formatOfName('scan.tif')?.id).toBe('tiff');
    expect(catalog.formatOfName('noextension')).toBeUndefined();
    const accept = catalog.acceptList().split(',');
    expect(accept).toEqual(
      expect.arrayContaining(['.heic', '.heif', '.dng', '.eps', '.ai', '.pdf', '.avif']),
    );
    expect(accept).not.toContain('.png');
    expect(accept).not.toContain('.docx');
  });

  it('asks for the right size, page and quality', () => {
    expect(
      importOptions(format('heic'), catalog.importTargets(format('heic'))[0]!, DEFAULT_IMPORT),
    ).toEqual({
      longSide: '2560',
      quality: 'high',
    });
    const png = catalog.importTargets(format('heic'))[1]!;
    expect(importOptions(format('heic'), png, { ...DEFAULT_IMPORT, longSide: 'original' })).toEqual(
      {},
    );
    const svg = catalog.importTargets(format('eps'))[0]!;
    expect(importOptions(format('eps'), svg, DEFAULT_IMPORT)).toEqual({});
    const [pdfPng, pdfJpg] = catalog.importTargets(format('pdf'));
    expect(
      importOptions(format('pdf'), pdfPng!, { ...DEFAULT_IMPORT, page: 3.7, dpi: '300' }),
    ).toEqual({
      pageRange: '3',
      dpi: '300',
    });
    expect(importOptions(format('pdf'), pdfJpg!, { ...DEFAULT_IMPORT, page: -2 })).toEqual({
      pageRange: '1',
      dpi: '150',
      quality: 'high',
    });
  });

  it('names a placed layer after its file', () => {
    expect(layerName('IMG_0042.HEIC')).toBe('IMG_0042');
    expect(layerName('logo.final.eps')).toBe('logo.final');
    expect(layerName('.eps')).toBe('Converted');
  });
});

describe('what the plugin exports', () => {
  it('offers every export the server can make from Penpot’s PNG or PDF', () => {
    expect(ids(catalog.exportTargets())).toEqual(['avif', 'webp', 'jpg', 'tiff', 'ico', 'pdf']);
    const noIcons = FORMATS.map((f) =>
      f.id === 'png' ? { ...f, to: f.to.filter((t) => t !== 'ico') } : f,
    );
    expect(ids(new Catalog(noIcons).exportTargets())).not.toContain('ico');
  });

  it('shows the settings each format takes', () => {
    expect(exportFields(EXPORT_TARGETS.avif)).toEqual({
      scale: true,
      quality: true,
      lossless: true,
      maxKb: true,
      iconSize: false,
      compression: false,
    });
    expect(exportFields(EXPORT_TARGETS.jpg)).toMatchObject({
      quality: true,
      lossless: false,
      maxKb: true,
    });
    expect(exportFields(EXPORT_TARGETS.tiff)).toMatchObject({
      scale: true,
      quality: false,
      maxKb: false,
    });
    expect(exportFields(EXPORT_TARGETS.ico)).toMatchObject({ scale: false, iconSize: true });
    expect(exportFields(EXPORT_TARGETS.pdf)).toMatchObject({ scale: false, compression: true });
  });

  it('turns the settings into Converter Studio’s options', () => {
    expect(exportOptions(EXPORT_TARGETS.webp, { ...DEFAULT_EXPORT, maxKb: 150.4 })).toEqual({
      quality: 'high',
      maxKb: 150,
    });
    expect(exportOptions(EXPORT_TARGETS.webp, { ...DEFAULT_EXPORT, maxKb: 1 })).toEqual({
      quality: 'high',
      maxKb: 5,
    });
    expect(
      exportOptions(EXPORT_TARGETS.avif, { ...DEFAULT_EXPORT, quality: 'lossless', maxKb: 100 }),
    ).toEqual({
      lossless: true,
    });
    // JPG has no lossless mode.
    expect(exportOptions(EXPORT_TARGETS.jpg, { ...DEFAULT_EXPORT, quality: 'lossless' })).toEqual({
      quality: 'high',
    });
    expect(exportOptions(EXPORT_TARGETS.tiff, DEFAULT_EXPORT)).toEqual({});
    expect(exportOptions(EXPORT_TARGETS.ico, { ...DEFAULT_EXPORT, iconSize: '256' })).toEqual({
      iconSize: '256',
    });
    expect(exportOptions(EXPORT_TARGETS.pdf, { ...DEFAULT_EXPORT, compression: 'strong' })).toEqual(
      {
        compression: 'strong',
      },
    );
  });

  it('exports icons from at least 256 px and the rest at the chosen scale', () => {
    expect(exportScale(EXPORT_TARGETS.ico, DEFAULT_EXPORT, { width: 32, height: 32 })).toBe(8);
    expect(exportScale(EXPORT_TARGETS.ico, DEFAULT_EXPORT, { width: 1, height: 1 })).toBe(16);
    expect(exportScale(EXPORT_TARGETS.ico, DEFAULT_EXPORT, { width: 512, height: 300 })).toBe(1);
    expect(exportScale(EXPORT_TARGETS.ico, DEFAULT_EXPORT, { width: 100, height: 60 })).toBe(2.56);
    expect(
      exportScale(EXPORT_TARGETS.avif, { ...DEFAULT_EXPORT, scale: 3 }, { width: 10, height: 10 }),
    ).toBe(3);
  });

  it('makes file names every system takes', () => {
    expect(fileName('Hero / Desktop: v2?', 'avif')).toBe('Hero Desktop v2.avif');
    expect(fileName('...hidden', 'png')).toBe('hidden.png');
    expect(fileName('  ', 'ico')).toBe('Layer.ico');
    expect(fileName('a'.repeat(300), 'pdf')).toHaveLength(124);
  });
});
