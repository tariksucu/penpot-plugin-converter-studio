import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_HEADER, ConverterApi } from '../src/ui/api';
import { version } from '../package.json';
import { BASE, KEY, fakeServer } from './fake-server';

const blob = (size: number) => new NodeBlob([new Uint8Array(size)]) as unknown as Blob;

describe('the Converter Studio API client', () => {
  it('names the plugin and its version on every call, sends the key only to API routes, and never cookies', async () => {
    const server = fakeServer();
    const api = new ConverterApi(BASE, KEY, server.fetch);
    expect(CLIENT_HEADER).toEqual({ 'X-Converter-Studio-Client': `penpot/${version}` });
    const upload = await api.createUpload('photo.heic', 10);
    await api.upload(upload, blob(10));
    const conversion = await api.convert({ uploadId: upload.id, to: 'webp' });
    const done = await api.status(conversion.id, 25);
    await api.download(done.downloadUrl!);
    for (const request of server.requests) expect(request.credentials).toBe('omit');
    const [create, put, convert, status, download] = server.requests;
    expect(create!.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      'X-Converter-Studio-Client': `penpot/${version}`,
    });
    expect(put!.headers.Authorization).toBeUndefined();
    expect(convert!.headers['Idempotency-Key']).toMatch(/^penpot-[0-9a-f-]{36}$/);
    expect(status!.url).toBe(`${BASE}/v1/conversions/${conversion.id}?wait=25`);
    expect(download!.headers.Authorization).toBeUndefined();
  });

  it('lists formats without a key', async () => {
    const server = fakeServer();
    const formats = await new ConverterApi(BASE, '', server.fetch).formats();
    expect(formats.some((f) => f.id === 'heic')).toBe(true);
    expect(server.requests[0]!.headers.Authorization).toBeUndefined();
  });

  it('sends a conversion once more with the same Idempotency-Key when its answer is lost', async () => {
    const server = fakeServer({ dropConversions: 1 });
    const api = new ConverterApi(BASE, KEY, server.fetch);
    const upload = await api.createUpload('a.png', 4);
    await api.upload(upload, blob(4));
    const conversion = await api.convert({ uploadId: upload.id, to: 'avif' });
    const tries = server.requests.filter((r) => r.url.endsWith('/v1/conversions'));
    expect(tries).toHaveLength(2);
    expect(tries[0]!.headers['Idempotency-Key']).toBe(tries[1]!.headers['Idempotency-Key']);
    expect(server.jobs.size).toBe(1);
    expect(conversion.id).toBe(upload.id);
  });

  it('gives up after a second lost answer with a plain sentence', async () => {
    const server = fakeServer({ dropConversions: 2 });
    const api = new ConverterApi(BASE, KEY, server.fetch);
    const upload = await api.createUpload('a.png', 4);
    await api.upload(upload, blob(4));
    await expect(api.convert({ uploadId: upload.id, to: 'avif' })).rejects.toMatchObject({
      code: 'network',
      message: 'Converter Studio could not be reached. Check your connection and try again.',
    });
  });

  it('shows the API’s own error message', async () => {
    const server = fakeServer({
      refuse: {
        status: 402,
        code: 'insufficientCredits',
        message: 'You need 1 credit; you have 0.',
      },
    });
    const api = new ConverterApi(BASE, KEY, server.fetch);
    const upload = await api.createUpload('a.png', 4);
    await api.upload(upload, blob(4));
    const error = await api.convert({ uploadId: upload.id, to: 'avif' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'insufficientCredits',
      status: 402,
      message: 'You need 1 credit; you have 0.',
    });
    await expect(
      new ConverterApi(BASE, 'cvs_live_wrong', server.fetch).account(),
    ).rejects.toMatchObject({
      code: 'invalidApiKey',
      message: 'This API key does not work.',
    });
  });

  it('reads errors that are not the API’s JSON', async () => {
    const api = new ConverterApi(BASE, KEY, () =>
      Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    await expect(api.account()).rejects.toMatchObject({
      code: 'http502',
      message: 'Converter Studio answered 502.',
    });
    const expired = new ConverterApi(BASE, KEY, () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'fileExpired' }), { status: 410 })),
    );
    await expect(expired.download(`${BASE}/jobs/x/download?token=t`)).rejects.toMatchObject({
      message: 'The converted file has expired. Convert it again.',
    });
  });

  it('refuses upload and download links that are not on the API’s site', async () => {
    const server = fakeServer();
    const api = new ConverterApi(BASE, KEY, server.fetch);
    for (const url of [
      'https://evil.example/api/jobs/x/download',
      'https://converter.studio.evil.example/api/jobs/x',
      'https://converter.studio/other/jobs/x',
      'not a url',
    ])
      await expect(api.download(url)).rejects.toMatchObject({ code: 'invalidRequest' });
    const upload = {
      id: 'u',
      uploadUrl: 'https://evil.example/upload',
      maxBytes: 10,
      partBytes: 10,
      expiresAt: '',
    };
    await expect(api.upload(upload, blob(1))).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(server.requests).toEqual([]);
  });

  it('uploads a large file in parts and resends from what the server has', async () => {
    const server = fakeServer({ shortPart: 3 });
    const api = new ConverterApi(BASE, KEY, server.fetch);
    const upload = await api.createUpload('big.dng', 25);
    const progress: number[] = [];
    await api.upload(upload, blob(25), {
      partBytes: 10,
      onProgress: (sent) => progress.push(sent),
    });
    const puts = server.requests.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.headers['Upload-Offset'])).toEqual(['0', '10', '7', '17']);
    expect(server.uploads.get(upload.id)!.received).toBe(25);
    expect(progress.at(-1)).toBe(25);
  });
});
