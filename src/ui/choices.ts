import type { ConversionOptions, FormatInfo } from './api';
import { IMAGE_TYPES, MAX_EXPORT_SCALE, type ImageType } from '../shared/messages';

/**
 * What the plugin offers, both ways.
 *
 * **Place a file.** Penpot places JPG, PNG, WebP, GIF and SVG files itself (its media types:
 * common/src/app/common/media.cljc). The plugin takes what it cannot: iPhone photos (HEIC),
 * camera RAW, AVIF, TIFF, BMP and ICO pictures, Illustrator and EPS drawings, and a page of a
 * PDF. Pictures arrive as WebP, PNG or JPG; drawings as an SVG that Penpot turns into editable
 * layers (or as a PNG); a PDF page as a PNG, JPG or WebP.
 *
 * **Export a selection.** Penpot exports PNG, JPEG, WebP, SVG and PDF, with a scale and no other
 * setting. The plugin exports the layer through Penpot (PNG, or PDF for a PDF) and converts it:
 * AVIF, WebP or JPG with a quality and an optional size limit, TIFF for print, an ICO (favicon),
 * or a smaller PDF.
 *
 * Only what the server can do right now (`/v1/formats`) is ever offered.
 */

/** What Penpot places on its own: the panel says so instead of converting. */
export const PENPOT_NATIVE = new Set(['jpg', 'png', 'webp', 'gif', 'svg']);

export type ImportGroup = 'photo' | 'drawing' | 'pdf';

/** Formats the panel places, by Converter Studio format id. */
export const IMPORT_SOURCES: Readonly<Record<string, ImportGroup>> = {
  heic: 'photo',
  avif: 'photo',
  tiff: 'photo',
  bmp: 'photo',
  ico: 'photo',
  cr2: 'photo',
  nef: 'photo',
  arw: 'photo',
  dng: 'photo',
  eps: 'drawing',
  ai: 'drawing',
  pdf: 'pdf',
};

export interface ImportTarget {
  readonly id: 'webp' | 'png' | 'jpg' | 'svg';
  readonly label: string;
  /** `svg` becomes editable layers; the rest a picture (`mime`). */
  readonly kind: 'image' | 'svg';
  readonly mime: ImageType | 'image/svg+xml';
}

export const IMPORT_TARGETS: Readonly<Record<ImportTarget['id'], ImportTarget>> = {
  webp: { id: 'webp', label: 'WebP picture', kind: 'image', mime: 'image/webp' },
  png: { id: 'png', label: 'PNG picture (lossless)', kind: 'image', mime: 'image/png' },
  jpg: { id: 'jpg', label: 'JPG picture', kind: 'image', mime: 'image/jpeg' },
  svg: { id: 'svg', label: 'Editable vector layers (SVG)', kind: 'svg', mime: 'image/svg+xml' },
};

/** What each group is offered as, best first. */
const IMPORT_OFFERS: Readonly<Record<ImportGroup, readonly ImportTarget['id'][]>> = {
  photo: ['webp', 'png', 'jpg'],
  drawing: ['svg', 'png'],
  pdf: ['png', 'jpg', 'webp'],
};

/** Pictures: the longer side at most (the API's `longSide`), or the original size. */
export const LONG_SIDES = ['2560', '1920', '1280', '800', 'original'] as const;
export type LongSide = (typeof LONG_SIDES)[number];
/** A PDF page's resolution (the API's `dpi`). */
export const PDF_DPIS = ['150', '300', '72'] as const;
export type PdfDpi = (typeof PDF_DPIS)[number];

export interface ImportSettings {
  readonly longSide: LongSide;
  readonly dpi: PdfDpi;
  /** A PDF's page, from 1. */
  readonly page: number;
}

export const DEFAULT_IMPORT: ImportSettings = { longSide: '2560', dpi: '150', page: 1 };

export class Catalog {
  private readonly byId = new Map<string, FormatInfo>();
  private readonly byExtension = new Map<string, FormatInfo>();

  constructor(formats: readonly FormatInfo[]) {
    for (const format of formats) {
      this.byId.set(format.id, format);
      for (const extension of format.extensions)
        this.byExtension.set(extension.toLowerCase(), format);
    }
  }

  get(id: string): FormatInfo | undefined {
    return this.byId.get(id);
  }

  /** A file's format, by its name's extension. */
  formatOfName(name: string): FormatInfo | undefined {
    const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
    return match ? this.byExtension.get(match[1]!.toLowerCase()) : undefined;
  }

  /** What a file can be placed as, best first (only what the server can do now). */
  importTargets(format: FormatInfo | undefined): ImportTarget[] {
    const group = format ? IMPORT_SOURCES[format.id] : undefined;
    if (!format || !group) return [];
    return IMPORT_OFFERS[group]
      .filter((id) => format.to.includes(id))
      .map((id) => IMPORT_TARGETS[id]);
  }

  /** The file picker's `accept`: every extension the panel places. */
  acceptList(): string {
    const extensions: string[] = [];
    for (const format of this.byId.values())
      if (this.importTargets(format).length > 0)
        extensions.push(...format.extensions.map((e) => `.${e}`));
    return extensions.join(',');
  }

  /** The export formats the server can make from Penpot's PNG (or PDF), in the panel's order. */
  exportTargets(): ExportTarget[] {
    return Object.values(EXPORT_TARGETS).filter((target) =>
      (this.byId.get(target.source)?.to ?? []).includes(target.to),
    );
  }
}

/** Converter Studio's options for placing a file. */
export function importOptions(
  format: FormatInfo,
  target: ImportTarget,
  settings: ImportSettings,
): ConversionOptions {
  const group = IMPORT_SOURCES[format.id];
  if (group === 'pdf') {
    const page = Math.max(1, Math.floor(settings.page));
    return {
      pageRange: String(page),
      dpi: settings.dpi,
      ...(target.id === 'png' ? {} : { quality: 'high' }),
    };
  }
  // Drawings: the vector engine has no size or quality settings.
  if (group === 'drawing') return {};
  const options: ConversionOptions = {};
  if (settings.longSide !== 'original') options.longSide = settings.longSide;
  if (target.id !== 'png') options.quality = 'high';
  return options;
}

// ── Export ────────────────────────────────────────────────────────────────────────────────

export type ExportId = 'avif' | 'webp' | 'jpg' | 'tiff' | 'ico' | 'pdf';

export interface ExportTarget {
  readonly id: ExportId;
  readonly label: string;
  /** What Penpot exports first, and what Converter Studio converts it from. */
  readonly penpot: 'png' | 'pdf';
  readonly source: 'png' | 'pdf';
  readonly to: string;
  readonly extension: string;
  readonly hint: string;
}

export const EXPORT_TARGETS: Readonly<Record<ExportId, ExportTarget>> = {
  avif: {
    id: 'avif',
    label: 'AVIF',
    penpot: 'png',
    source: 'png',
    to: 'avif',
    extension: 'avif',
    hint: 'Smallest web images, with transparency.',
  },
  webp: {
    id: 'webp',
    label: 'WebP (size limit)',
    penpot: 'png',
    source: 'png',
    to: 'webp',
    extension: 'webp',
    hint: 'Choose a quality, or a size the file must stay under.',
  },
  jpg: {
    id: 'jpg',
    label: 'JPG (size limit)',
    penpot: 'png',
    source: 'png',
    to: 'jpg',
    extension: 'jpg',
    hint: 'For email and older tools. Transparent parts turn white.',
  },
  tiff: {
    id: 'tiff',
    label: 'TIFF',
    penpot: 'png',
    source: 'png',
    to: 'tiff',
    extension: 'tiff',
    hint: 'Lossless, for print and photo tools.',
  },
  ico: {
    id: 'ico',
    label: 'ICO (favicon)',
    penpot: 'png',
    source: 'png',
    to: 'ico',
    extension: 'ico',
    hint: 'A favicon with 16, 32 and 48 px, or one size up to 256 px.',
  },
  pdf: {
    id: 'pdf',
    label: 'PDF (smaller)',
    penpot: 'pdf',
    source: 'pdf',
    to: 'pdf',
    extension: 'pdf',
    hint: "Penpot's PDF with its pictures compressed.",
  },
};

export const QUALITIES = ['high', 'balanced', 'small', 'lossless'] as const;
export type Quality = (typeof QUALITIES)[number];
export const ICON_SIZES = ['favicon', '256', '128', '64', '48', '32', '16'] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const COMPRESSIONS = ['balanced', 'strong', 'light'] as const;
export type Compression = (typeof COMPRESSIONS)[number];
export const SCALES = [1, 2, 3, 4] as const;
/** The API's `maxKb` limits. */
export const MIN_KB = 5;
export const MAX_KB = 100_000;

export interface ExportSettings {
  readonly scale: number;
  readonly quality: Quality;
  /** Kilobytes (1000 bytes) the file must stay under; `null`: no limit. */
  readonly maxKb: number | null;
  readonly iconSize: IconSize;
  readonly compression: Compression;
}

export const DEFAULT_EXPORT: ExportSettings = {
  scale: 1,
  quality: 'high',
  maxKb: null,
  iconSize: 'favicon',
  compression: 'balanced',
};

/** Which settings a target shows. */
export function exportFields(target: ExportTarget): {
  scale: boolean;
  quality: boolean;
  lossless: boolean;
  maxKb: boolean;
  iconSize: boolean;
  compression: boolean;
} {
  const lossy = target.id === 'avif' || target.id === 'webp' || target.id === 'jpg';
  return {
    scale: target.penpot === 'png' && target.id !== 'ico',
    quality: lossy,
    lossless: target.id === 'avif' || target.id === 'webp',
    maxKb: lossy,
    iconSize: target.id === 'ico',
    compression: target.id === 'pdf',
  };
}

/**
 * The scale Penpot exports a layer at. An icon is drawn from at least 256 px on its longer side
 * (Converter Studio scales it down to each icon size); everything else at the chosen scale.
 */
export function exportScale(
  target: ExportTarget,
  settings: ExportSettings,
  layer: { width: number; height: number },
): number {
  if (target.id === 'ico') {
    const longer = Math.max(layer.width, layer.height, 1);
    return Math.min(MAX_EXPORT_SCALE, Math.max(1, Math.ceil((256 / longer) * 100) / 100));
  }
  return Math.min(MAX_EXPORT_SCALE, Math.max(1, settings.scale));
}

/** Converter Studio's options for an export. */
export function exportOptions(target: ExportTarget, settings: ExportSettings): ConversionOptions {
  const fields = exportFields(target);
  const options: ConversionOptions = {};
  if (fields.quality) {
    if (settings.quality === 'lossless' && fields.lossless) options.lossless = true;
    else options.quality = settings.quality === 'lossless' ? 'high' : settings.quality;
  }
  if (fields.maxKb && settings.maxKb !== null && !options.lossless)
    options.maxKb = Math.min(MAX_KB, Math.max(MIN_KB, Math.round(settings.maxKb)));
  if (fields.iconSize) options.iconSize = settings.iconSize;
  if (fields.compression) options.compression = settings.compression;
  return options;
}

/** A file name from a layer's name: what a file system takes, with the target's extension. */
export function fileName(layerName: string, extension: string): string {
  const base =
    layerName
      // Characters Windows, macOS or Linux refuse in a name.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120) || 'Layer';
  return `${base}.${extension}`;
}

/** A placed file's layer name: the file's name without its extension. */
export function layerName(file: string): string {
  return file.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Converted';
}

export const isImageType = (mime: string): mime is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(mime);

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1).replace(/\.0$/, '')} MB`;
}
