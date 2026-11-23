import type { Conversion, FormatInfo } from '../src/ui/api';
import formatsFixture from './fixtures/formats.json';

/**
 * Converter Studio's REST API in memory, behind a `fetch`: what the panel's code sends and how
 * it reacts to answers, without a server. Shapes follow the API reference
 * (https://converter.studio/developers).
 */

export const BASE = 'https://converter.studio/api';
export const KEY = `cvs_live_${'a'.repeat(32)}`;
export const FORMATS = (formatsFixture as { formats: FormatInfo[] }).formats;

export interface Scenario {
  /** The price of each conversion. */
  credits: number;
  /** The result's bytes. */
  output: Uint8Array;
  /** The result's file name, when it is not the input's with the new extension. */
  outputName?: string;
  /** How many status checks before a conversion is done. */
  polls: number;
  /** A conversion that fails with this error. */
  fail?: { code: string; message: string };
  /** POST /v1/conversions answers with this error. */
  refuse?: { status: number; code: string; message: string };
  /** POST /v1/conversions loses its first answer this many times (a network error). */
  dropConversions?: number;
  /** The first upload part arrives short by this many bytes (a 409 gap follows). */
  shortPart?: number;
}

export interface Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials | undefined;
  readonly body: unknown;
}

interface Job {
  id: string;
  status: Conversion['status'];
  to: string;
  inputName: string;
  credits: number;
  maxCredits: number | null;
  polls: number;
  options: unknown;
}

export function fakeServer(overrides: Partial<Scenario> = {}) {
  const scenario: Scenario = {
    credits: 1,
    output: new Uint8Array([1, 2, 3, 4]),
    polls: 1,
    ...overrides,
  };
  const requests: Request[] = [];
  const uploads = new Map<string, { name: string; size: number; received: number }>();
  const jobs = new Map<string, Job>();
  /** Idempotency-Key → conversion id. */
  const keys = new Map<string, string>();
  let next = 1;
  let shortPart = scenario.shortPart ?? 0;
  let drop = scenario.dropConversions ?? 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  const error = (status: number, code: string, message: string, params?: object) =>
    json(status, { error: { code, message, ...(params ? { params } : {}) } });

  const view = (job: Job): Conversion => {
    const done = job.status === 'done';
    return {
      id: job.id,
      status: job.status,
      from: 'png',
      to: job.to,
      inputName: job.inputName,
      credits: job.credits,
      progress: done ? 1 : null,
      outputName: done
        ? (scenario.outputName ?? job.inputName.replace(/\.\w+$/, `.${job.to}`))
        : null,
      outputSize: done ? scenario.output.byteLength : null,
      downloadUrl: done ? `${BASE}/jobs/${job.id}/download?token=t-${job.id}` : null,
      expiresAt: done ? '2026-11-23T12:00:00.000Z' : null,
      error: job.status === 'failed' && scenario.fail ? scenario.fail : null,
    };
  };

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const url = new URL(input);
    if (method === 'POST' && url.pathname === '/api/v1/conversions' && drop > 0) {
      // The server makes the conversion, but its answer never arrives.
      answer(input, init);
      drop -= 1;
      throw new TypeError('Failed to fetch');
    }
    return answer(input, init);
  };

  const answer = (input: string, init: RequestInit): Response => {
    const method = init.method ?? 'GET';
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    let body: unknown = init.body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    requests.push({ method, url: input, headers, credentials: init.credentials, body });
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api/, '');
    const keyed = headers.Authorization === `Bearer ${KEY}`;

    if (method === 'GET' && path === '/v1/formats') return json(200, { formats: FORMATS });
    if (path.startsWith('/v1/uploads/') && method === 'PUT') {
      const id = path.split('/')[3]!;
      const upload = uploads.get(id);
      if (!upload || url.searchParams.get('token') !== `t-${id}` || headers.Authorization)
        return error(404, 'notFound', 'Not found.');
      const blob = init.body as Blob;
      const offset =
        headers['Upload-Offset'] === undefined ? null : Number(headers['Upload-Offset']);
      if (offset !== null && offset > upload.received)
        return error(409, 'invalidRequest', 'Gap.', { received: upload.received });
      let size = blob.size;
      if (shortPart > 0) {
        size -= shortPart;
        shortPart = 0;
      }
      upload.received = (offset ?? 0) + size;
      if (offset !== null && upload.received < upload.size)
        return json(200, { id, status: 'partial', received: upload.received });
      return json(200, { id, status: 'ready', file: { name: upload.name, size: upload.received } });
    }
    if (path.startsWith('/jobs/') && path.endsWith('/download')) {
      const id = path.split('/')[2]!;
      if (url.searchParams.get('token') !== `t-${id}` || headers.Authorization)
        return json(404, { error: 'notFound' });
      return new Response(scenario.output.slice(), { status: 200 });
    }
    if (!keyed) return error(401, 'invalidApiKey', 'This API key does not work.');

    if (method === 'GET' && path === '/v1/account')
      return json(200, {
        email: 'designer@example.com',
        plan: 'guest',
        credits: 12,
        maxFileBytes: 250 * 1024 * 1024,
      });
    if (method === 'POST' && path === '/v1/uploads') {
      const { fileName, size } = body as { fileName: string; size: number };
      const id = `up${next++}abcdef`;
      uploads.set(id, { name: fileName, size, received: 0 });
      return json(201, {
        id,
        uploadUrl: `${BASE}/v1/uploads/${id}?token=t-${id}`,
        method: 'PUT',
        maxBytes: 250 * 1024 * 1024,
        partBytes: 95 * 1024 * 1024,
        expiresAt: '2026-11-23T12:00:00.000Z',
      });
    }
    if (method === 'POST' && path === '/v1/conversions') {
      if (scenario.refuse)
        return error(scenario.refuse.status, scenario.refuse.code, scenario.refuse.message);
      const idempotency = headers['Idempotency-Key'];
      const repeat = idempotency ? keys.get(idempotency) : undefined;
      if (repeat) return json(200, view(jobs.get(repeat)!), { 'Idempotent-Replayed': 'true' });
      const request = body as {
        to: string;
        uploadId: string;
        maxCredits?: number;
        options?: unknown;
      };
      const upload = uploads.get(request.uploadId);
      if (!upload || upload.received < upload.size)
        return error(404, 'notFound', 'Upload the file first.');
      const id = request.uploadId;
      uploads.delete(id);
      const maxCredits = request.maxCredits ?? 20;
      const job: Job = {
        id,
        to: request.to,
        inputName: upload.name,
        credits: scenario.credits,
        maxCredits,
        polls: scenario.polls,
        options: request.options,
        status: scenario.credits > maxCredits ? 'quoted' : 'queued',
      };
      jobs.set(id, job);
      if (idempotency) keys.set(idempotency, id);
      return json(201, view(job));
    }
    const match = /^\/v1\/conversions\/([^/]+)(\/confirm)?$/.exec(path);
    const job = match ? jobs.get(match[1]!) : undefined;
    if (match && !job) return error(404, 'notFound', 'Not found.');
    if (job && method === 'POST' && match?.[2]) {
      job.status = 'queued';
      job.maxCredits = null;
      return json(200, view(job));
    }
    if (job && method === 'GET') {
      if (job.status === 'queued' || job.status === 'processing') {
        job.polls -= 1;
        job.status = job.polls <= 0 ? (scenario.fail ? 'failed' : 'done') : 'processing';
      }
      return json(200, view(job));
    }
    return error(404, 'notFound', 'Not found.');
  };

  return { fetch, requests, jobs, uploads, scenario };
}
