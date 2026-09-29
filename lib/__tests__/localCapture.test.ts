// Tests for LocalCaptureProvider.transcribeChunk (T4.7).
//
// The batch captureRecording path is tested by the capture-service pytest
// suite (via the typescript parity tests). This file covers the new live-
// transcript client: happy path, strict response validation, and error mapping.

import { describe, it, expect, vi } from 'vitest';
import { LocalCaptureProvider, LocalCaptureError } from '../connectors/capture/local';

function mockFetch(response: Response) {
  return vi.fn(async () => response);
}

function jsonOk(transcript: unknown[]): Response {
  return new Response(JSON.stringify({ transcript }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LocalCaptureProvider.transcribeChunk', () => {
  it('returns joined text from a valid transcript response', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(jsonOk([
        { speakerId: 'speaker-1', text: ' Hello ', startMs: 0, endMs: 1000 },
        { speakerId: 'speaker-1', text: 'world.', startMs: 1000, endMs: 2000 },
      ])),
    });

    const result = await provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' }));
    expect(result).toBe('Hello world.');
  });

  it('returns empty string when the transcript array is empty', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(jsonOk([])),
    });

    const result = await provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' }));
    expect(result).toBe('');
  });

  it('skips entries with empty or whitespace-only text', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(jsonOk([
        { text: '  ', startMs: 0, endMs: 1000 },
        { text: 'Real speech.', startMs: 1000, endMs: 2000 },
        { text: '', startMs: 2000, endMs: 3000 },
      ])),
    });

    const result = await provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' }));
    expect(result).toBe('Real speech.');
  });

  it('throws when the response has no transcript array', async () => {
    const badProvider = new LocalCaptureProvider({
      fetchFn: mockFetch(new Response(JSON.stringify({ notTranscript: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(
      badProvider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toThrow(LocalCaptureError);
  });

  it('throws when a transcript entry has no string text', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(jsonOk([{ speakerId: 'x', startMs: 0, endMs: 1000 }])),
    });

    await expect(
      provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toThrow(/no string text/);
  });

  it('throws when the response is not JSON', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    });

    await expect(
      provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toThrow(LocalCaptureError);
  });

  it('maps a non-ok response through the same error translation as captureRecording', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: mockFetch(new Response(JSON.stringify({ error: 'empty_upload' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(
      provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toMatchObject({ code: 'empty_upload' });
  });

  it('throws a network error when fetch rejects', async () => {
    const provider = new LocalCaptureProvider({
      fetchFn: vi.fn(async () => { throw new TypeError('failed'); }),
    });

    await expect(
      provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' })),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('throws an aborted error when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new LocalCaptureProvider({
      fetchFn: vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }),
    });

    await expect(
      provider.transcribeChunk(new Blob(['audio'], { type: 'audio/webm' }), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});
