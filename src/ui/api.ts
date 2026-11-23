/**
 * A small client for the Converter Studio REST API (https://converter.studio/developers), used by
 * the panel. Everything goes through `fetch`, which the caller passes in, so tests can stand in
 * for it.
 *
 * The panel is served from converter.studio and calls https://converter.studio/api: the same
 * origin, so no CORS is involved in production. Requests never carry cookies
 * (`credentials: 'omit'`): the API key is the only credential. It is sent only to the API's own
 * routes; upload and download links carry their own token, and those requests go without it.
 */

import { version } from '../../package.json';

/**
 * Names this plugin, with its version, on its API calls (Converter Studio's statistics of its
 * connectors). A header of its own: code in a browser cannot set the User-Agent.
 */
export const CLIENT_HEADER = { 'X-Converter-Studio-Client': `penpot/${version}` };

/** What the API says when something goes wrong: `{ error: { code, message, params } }`. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly params?: Record<string, string | number>;
}

/** A failed request. `code` is the API's error code, or `network` when nothing came back. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface FormatInfo {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly extensions: readonly string[];
  /** What it converts to on the server right now. */
  readonly to: readonly string[];
}

export interface Account {
  readonly email: string;
  readonly plan: string;
  readonly credits: number;
  readonly maxFileBytes: number;
}

export interface Upload {
  readonly id: string;
  readonly uploadUrl: string;
  readonly maxBytes: number;
  readonly partBytes: number;
  readonly expiresAt: string;
}

export type ConversionStatus =
  | 'fetching'
  | 'waiting_for_upload'
  | 'measuring'
  | 'quoted'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'expired'
  | 'canceled';

export interface Conversion {
  readonly id: string;
  readonly status: ConversionStatus;
  readonly from: string | null;
  readonly to: string | null;
  readonly inputName: string | null;
  readonly credits: number | null;
  readonly progress: number | null;
  readonly outputName: string | null;
  readonly outputSize: number | null;
  readonly downloadUrl: string | null;
  readonly expiresAt: string | null;
  readonly error: ApiErrorBody | null;
}

export type ConversionOptions = Record<string, string | number | boolean>;

export interface ConvertRequest {
  readonly uploadId: string;
  readonly to: string;
  readonly options?: ConversionOptions;
  /** Goes ahead on its own up to this price; above it the conversion waits for `confirm`. */
  readonly maxCredits?: number;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Statuses after which a conversion no longer changes on its own. */
export const SETTLED: ReadonlySet<ConversionStatus> = new Set([
  'done',
  'failed',
  'expired',
  'canceled',
  'quoted',
]);

/** A fresh `Idempotency-Key`: the same one goes with every try of one conversion request. */
export function idempotencyKey(): string {
  return `penpot-${crypto.randomUUID()}`;
}

export class ConverterApi {
  readonly base: string;

  /** `base`: the API's root, e.g. `https://converter.studio/api`. */
  constructor(
    base: string,
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = (input, init) => fetch(input, init),
  ) {
    this.base = base.replace(/\/$/, '');
  }

  /** The formats need no key: the panel lists them before one is entered. */
  formats(): Promise<FormatInfo[]> {
    return this.call<{ formats: FormatInfo[] }>('GET', '/v1/formats').then((r) => r.formats);
  }

  account(): Promise<Account> {
    return this.call('GET', '/v1/account');
  }

  createUpload(fileName: string, size: number): Promise<Upload> {
    return this.call('POST', '/v1/uploads', { fileName, size });
  }

  /**
   * Sends a file to an upload slot: in one request when it is small, otherwise in parts
   * (`Upload-Offset`), which also gives progress and lets a broken part be sent again.
   */
  async upload(
    upload: Upload,
    file: Blob,
    options: { partBytes?: number; onProgress?: (sent: number) => void; signal?: AbortSignal } = {},
  ): Promise<void> {
    const partBytes = Math.min(options.partBytes ?? 8 * 1024 * 1024, upload.partBytes);
    if (file.size <= partBytes) {
      await this.put(upload.uploadUrl, file, {}, options.signal);
      options.onProgress?.(file.size);
      return;
    }
    let offset = 0;
    let retried = false;
    while (offset < file.size) {
      const end = Math.min(offset + partBytes, file.size);
      try {
        await this.put(
          upload.uploadUrl,
          file.slice(offset, end),
          { 'Upload-Offset': String(offset) },
          options.signal,
        );
      } catch (error) {
        // A part the server did not get whole: go on from what it has, once.
        if (!retried && error instanceof ApiError && typeof error.params.received === 'number') {
          retried = true;
          offset = error.params.received;
          continue;
        }
        throw error;
      }
      offset = end;
      options.onProgress?.(offset);
    }
  }

  /**
   * Starts a conversion. A request whose answer was lost (the network dropped) is sent once
   * more with the same `Idempotency-Key`: the server then answers with the first conversion
   * instead of making (and charging) a second one.
   */
  async convert(request: ConvertRequest, key = idempotencyKey()): Promise<Conversion> {
    const headers = { 'Idempotency-Key': key };
    try {
      return await this.call<Conversion>('POST', '/v1/conversions', request, undefined, headers);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'network') throw error;
      return this.call<Conversion>('POST', '/v1/conversions', request, undefined, headers);
    }
  }

  /** The conversion now, or (with `waitSeconds`) once it settles or that time has passed. */
  status(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<Conversion> {
    const wait = waitSeconds > 0 ? `?wait=${Math.min(60, Math.round(waitSeconds))}` : '';
    return this.call('GET', `/v1/conversions/${encodeURIComponent(id)}${wait}`, undefined, signal);
  }

  confirm(id: string): Promise<Conversion> {
    return this.call('POST', `/v1/conversions/${encodeURIComponent(id)}/confirm`);
  }

  /** The result's file. Its link carries its own token (valid until the result expires). */
  async download(url: string, signal?: AbortSignal): Promise<Blob> {
    this.checkLink(url, 'result');
    const response = await this.send(url, { method: 'GET', signal });
    if (!response.ok) throw await errorOf(response);
    return response.blob();
  }

  /** Upload and download links must point at the API's own site, never anywhere else. */
  checkLink(url: string, what: 'upload' | 'result'): void {
    let link: URL;
    let api: URL;
    try {
      link = new URL(url);
      api = new URL(this.base);
    } catch {
      throw new ApiError('invalidRequest', `The ${what} link is not on Converter Studio.`, 0);
    }
    if (link.origin !== api.origin || !link.pathname.startsWith(`${api.pathname}/`))
      throw new ApiError('invalidRequest', `The ${what} link is not on Converter Studio.`, 0);
  }

  private async put(
    url: string,
    body: Blob,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.checkLink(url, 'upload');
    const response = await this.send(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body,
      signal,
    });
    if (!response.ok) throw await errorOf(response);
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...CLIENT_HEADER, ...extra };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.send(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await errorOf(response);
    return (await response.json()) as T;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, credentials: 'omit' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(
        'network',
        'Converter Studio could not be reached. Check your connection and try again.',
        0,
      );
    }
  }
}

async function errorOf(response: Response): Promise<ApiError> {
  let body: { error?: ApiErrorBody | string } | null;
  try {
    body = (await response.json()) as { error?: ApiErrorBody | string };
  } catch {
    // Not JSON (a proxy's error page).
    body = null;
  }
  const error = body?.error;
  if (error && typeof error === 'object' && typeof error.message === 'string')
    return new ApiError(error.code, error.message, response.status, error.params ?? {});
  // The site's own routes (downloads) answer `{ error: 'code' }`.
  const code = typeof error === 'string' ? error : `http${response.status}`;
  return new ApiError(
    code,
    MESSAGES[code] ?? `Converter Studio answered ${response.status}.`,
    response.status,
  );
}

const MESSAGES: Record<string, string> = {
  fileExpired: 'The converted file has expired. Convert it again.',
  notFound: 'Converter Studio could not find this conversion.',
  tooManyRequests: 'Too many requests. Wait a minute and try again.',
  serverBusy: 'Converter Studio is busy right now. Try again in a few minutes.',
};
