import {
  ApiError,
  SETTLED,
  type Conversion,
  type ConversionOptions,
  type ConversionStatus,
  type ConverterApi,
} from './api';

/**
 * One conversion, from start to finish: the file goes up to Converter Studio, it is converted on
 * the account's credits (asking first above `AUTO_CONFIRM_CREDITS`), and the finished
 * conversion comes back with its download link. Waiting is a long poll (`?wait=25`): the server
 * answers as soon as the conversion settles, or after 25 seconds, so the panel asks about once
 * every 25 seconds at most and never hammers the API.
 */

/** Conversions up to this many credits go ahead without asking (a picture costs 1). */
export const AUTO_CONFIRM_CREDITS = 3;
/** How long one conversion may take before the panel stops waiting. */
export const TIMEOUT_MS = 15 * 60_000;
/** The long poll's wait, in seconds. */
export const WAIT_SECONDS = 25;

export interface Job {
  readonly file: Blob;
  /** The name Converter Studio sees; the result's name follows it. */
  readonly name: string;
  readonly to: string;
  readonly options: ConversionOptions;
}

export type Step =
  | { readonly step: 'uploading'; readonly sent: number; readonly total: number }
  | {
      readonly step: 'converting';
      readonly status: ConversionStatus;
      readonly progress: number | null;
    };

export interface Hooks {
  readonly onStep?: (step: Step) => void;
  /** The price is above `AUTO_CONFIRM_CREDITS`: resolve `true` to pay it and go ahead. */
  readonly confirmPrice: (credits: number) => Promise<boolean>;
  readonly signal?: AbortSignal;
  /** The size of an upload's parts (smaller files go in one request). */
  readonly partBytes?: number;
  /** Tests make time pass faster. */
  readonly now?: () => number;
}

/** A finished conversion: `status` is `done` and the download link is there. */
export interface Finished {
  readonly conversion: Conversion;
  readonly downloadUrl: string;
  readonly credits: number;
  readonly size: number;
  readonly expiresAt: string | null;
}

export async function runConversion(api: ConverterApi, job: Job, hooks: Hooks): Promise<Finished> {
  const now = hooks.now ?? Date.now;
  const deadline = now() + TIMEOUT_MS;

  hooks.onStep?.({ step: 'uploading', sent: 0, total: job.file.size });
  const upload = await api.createUpload(job.name, job.file.size);
  await api.upload(upload, job.file, {
    signal: hooks.signal,
    partBytes: hooks.partBytes,
    onProgress: (sent) => hooks.onStep?.({ step: 'uploading', sent, total: job.file.size }),
  });
  let conversion = await api.convert({
    uploadId: upload.id,
    to: job.to,
    options: job.options,
    maxCredits: AUTO_CONFIRM_CREDITS,
  });

  for (;;) {
    hooks.onStep?.({
      step: 'converting',
      status: conversion.status,
      progress: conversion.progress,
    });
    if (conversion.status === 'quoted') {
      const credits = conversion.credits ?? 0;
      if (!(await hooks.confirmPrice(credits)))
        throw new ApiError('canceled', 'Canceled. Nothing was charged.', 0);
      conversion = await api.confirm(conversion.id);
      continue;
    }
    if (SETTLED.has(conversion.status)) break;
    if (hooks.signal?.aborted) throw new ApiError('canceled', 'Canceled.', 0);
    if (now() > deadline)
      throw new ApiError(
        'timeout',
        'The conversion is taking too long. Try again, or try a smaller file.',
        0,
      );
    conversion = await api.status(conversion.id, WAIT_SECONDS, hooks.signal);
  }

  if (conversion.status !== 'done' || !conversion.downloadUrl) {
    const error = conversion.error;
    if (error) throw new ApiError(error.code, error.message, 0, error.params ?? {});
    throw new ApiError(
      conversion.status,
      conversion.status === 'expired'
        ? 'The result expired before it could be used. Convert the file again.'
        : 'The conversion did not finish. No credits were charged for it.',
      0,
    );
  }
  if (conversion.outputName?.toLowerCase().endsWith('.zip'))
    throw new ApiError('notOneFile', 'The result is several files (a ZIP), not one picture.', 0);
  return {
    conversion,
    downloadUrl: conversion.downloadUrl,
    credits: conversion.credits ?? 0,
    size: conversion.outputSize ?? 0,
    expiresAt: conversion.expiresAt,
  };
}
