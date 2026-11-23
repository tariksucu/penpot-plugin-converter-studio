import { Blob as NodeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { ConverterApi } from '../src/ui/api';
import { AUTO_CONFIRM_CREDITS, TIMEOUT_MS, runConversion, type Step } from '../src/ui/convert';
import { BASE, KEY, fakeServer, type Scenario } from './fake-server';

const file = new NodeBlob([new Uint8Array(10)]) as unknown as Blob;
const job = { file, name: 'IMG_0042.HEIC', to: 'webp', options: { longSide: '2560' } };

function setup(scenario: Partial<Scenario> = {}) {
  const server = fakeServer(scenario);
  return { server, api: new ConverterApi(BASE, KEY, server.fetch) };
}

describe('one conversion', () => {
  it('uploads, converts within the credit limit and returns the download link', async () => {
    const { server, api } = setup({ polls: 2, output: new Uint8Array(42) });
    const steps: Step[] = [];
    const confirmPrice = vi.fn();
    const finished = await runConversion(api, job, { onStep: (s) => steps.push(s), confirmPrice });
    expect(finished).toMatchObject({ credits: 1, size: 42, expiresAt: '2026-11-23T12:00:00.000Z' });
    expect(finished.downloadUrl).toMatch(`${BASE}/jobs/`);
    expect(confirmPrice).not.toHaveBeenCalled();
    const convert = server.requests.find((r) => r.url.endsWith('/v1/conversions'))!;
    expect(convert.body).toEqual({
      uploadId: expect.any(String),
      to: 'webp',
      options: { longSide: '2560' },
      maxCredits: AUTO_CONFIRM_CREDITS,
    });
    expect(steps[0]).toEqual({ step: 'uploading', sent: 0, total: 10 });
    expect(steps.at(-1)).toMatchObject({ step: 'converting', status: 'done' });
  });

  it('asks before a dearer conversion, and goes ahead when told to', async () => {
    const { server, api } = setup({ credits: 5 });
    const confirmPrice = vi.fn(() => Promise.resolve(true));
    await runConversion(api, job, { confirmPrice });
    expect(confirmPrice).toHaveBeenCalledWith(5);
    expect(server.requests.some((r) => r.url.endsWith('/confirm'))).toBe(true);
  });

  it('stops without charging when the price is declined', async () => {
    const { server, api } = setup({ credits: 5 });
    await expect(
      runConversion(api, job, { confirmPrice: () => Promise.resolve(false) }),
    ).rejects.toMatchObject({ code: 'canceled', message: 'Canceled. Nothing was charged.' });
    expect(server.requests.some((r) => r.url.endsWith('/confirm'))).toBe(false);
  });

  it('reports a failed conversion with the API’s message', async () => {
    const { api } = setup({
      fail: { code: 'conversionFailed', message: 'This file could not be read as a HEIC photo.' },
    });
    await expect(runConversion(api, job, { confirmPrice: vi.fn() })).rejects.toMatchObject({
      code: 'conversionFailed',
      message: 'This file could not be read as a HEIC photo.',
    });
  });

  it('refuses a result that is several files', async () => {
    const { api } = setup({ outputName: 'pages.zip' });
    await expect(runConversion(api, job, { confirmPrice: vi.fn() })).rejects.toMatchObject({
      code: 'notOneFile',
    });
  });

  it('stops waiting after the time limit', async () => {
    const { api } = setup({ polls: 1000 });
    let t = 0;
    await expect(
      runConversion(api, job, { confirmPrice: vi.fn(), now: () => (t += TIMEOUT_MS / 3) }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops when canceled', async () => {
    const { api } = setup({ polls: 1000 });
    const run = new AbortController();
    const steps: Step[] = [];
    const promise = runConversion(api, job, {
      confirmPrice: vi.fn(),
      signal: run.signal,
      onStep: (step) => {
        steps.push(step);
        if (step.step === 'converting' && step.status === 'processing') run.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ code: 'canceled' });
  });
});
