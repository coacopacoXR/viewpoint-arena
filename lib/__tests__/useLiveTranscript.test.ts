// Tests for useLiveTranscript (T4.7) — queue ordering, backpressure, silence
// filter, and the 3-failure cutoff.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveTranscript, isSilenceHallucination } from '../useLiveTranscript';
import { useStore } from '../../store';

// Mock the broadcast function so tests do not need a PartyKit socket.
vi.mock('../usePartyPresence', () => ({
  broadcastTranscriptLine: vi.fn(),
}));

function makeProvider(transcribeFn: (blob: Blob) => Promise<string>) {
  const transcribeChunk = vi.fn(transcribeFn);
  return { transcribeChunk } as unknown as Parameters<typeof useLiveTranscript>[0]['provider'] & {
    transcribeChunk: typeof transcribeChunk;
  };
}

function makeBlob(label = 'audio'): Blob {
  return new Blob([label], { type: 'audio/webm' });
}

beforeEach(() => {
  // Reset the chat history between tests.
  useStore.setState({ chatHistory: [] });
});

describe('isSilenceHallucination', () => {
  it('matches known Whisper silence hallucinations (case-insensitive)', () => {
    expect(isSilenceHallucination('Thank you.')).toBe(true);
    expect(isSilenceHallucination('thank you.')).toBe(true);
    expect(isSilenceHallucination('Thanks for watching!')).toBe(true);
    expect(isSilenceHallucination('you')).toBe(true);
    expect(isSilenceHallucination('.')).toBe(true);
  });

  it('does not match real speech', () => {
    expect(isSilenceHallucination('Thank you for your attention')).toBe(false);
    expect(isSilenceHallucination('The bracket will crack.')).toBe(false);
    expect(isSilenceHallucination('you should check the weld')).toBe(false);
  });
});

describe('useLiveTranscript — queue', () => {
  it('processes chunks in order', async () => {
    const order: string[] = [];
    const provider = makeProvider(async (blob: Blob) => {
      const text = await blob.text();
      order.push(text);
      return text.toUpperCase();
    });

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob('first'), 0);
      result.current.onLiveChunk(makeBlob('second'), 8000);
      result.current.onLiveChunk(makeBlob('third'), 16000);
      // Wait for all to process.
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(order).toEqual(['first', 'second', 'third']);

    const { chatHistory } = useStore.getState();
    const texts = chatHistory.map((m) => m.text);
    expect(texts).toEqual(['FIRST', 'SECOND', 'THIRD']);
  });

  it('drops a silence hallucination without adding a chat message', async () => {
    const provider = makeProvider(async () => 'Thank you.');

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob(), 0);
      await new Promise((r) => setTimeout(r, 50));
    });

    const { chatHistory } = useStore.getState();
    expect(chatHistory).toHaveLength(0);
  });

  it('drops an empty transcription result', async () => {
    const provider = makeProvider(async () => '   ');

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob(), 0);
      await new Promise((r) => setTimeout(r, 50));
    });

    const { chatHistory } = useStore.getState();
    expect(chatHistory).toHaveLength(0);
  });

  it('adds a gap line when chunks are dropped due to backpressure', async () => {
    // Slow transcriber: each chunk takes 100ms, so the queue builds up.
    let resolveCurrent: (() => void) | null = null;
    const provider = makeProvider(async () => {
      await new Promise<void>((resolve) => { resolveCurrent = resolve; });
      resolveCurrent = null;
      return 'transcribed';
    });

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    await act(async () => {
      // Enqueue 5 chunks rapidly. MAX_PENDING is 3, so 2+ should be dropped.
      result.current.onLiveChunk(makeBlob('a'), 0);
      result.current.onLiveChunk(makeBlob('b'), 8000);
      result.current.onLiveChunk(makeBlob('c'), 16000);
      result.current.onLiveChunk(makeBlob('d'), 24000);
      result.current.onLiveChunk(makeBlob('e'), 32000);

      // Let the first one complete.
      await new Promise((r) => setTimeout(r, 10));
      resolveCurrent?.();
      await new Promise((r) => setTimeout(r, 50));
    });

    const { chatHistory } = useStore.getState();
    const texts = chatHistory.map((m) => m.text);
    // At least one message should be the gap line.
    const gapLines = texts.filter((t) => t.includes('transcript skipped'));
    expect(gapLines.length).toBeGreaterThanOrEqual(1);
  });

  it('stops sending after 3 consecutive failures and shows unavailable', async () => {
    const provider = makeProvider(async () => {
      throw new Error('transcriber down');
    });

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob('a'), 0);
      result.current.onLiveChunk(makeBlob('b'), 8000);
      result.current.onLiveChunk(makeBlob('c'), 16000);
      result.current.onLiveChunk(makeBlob('d'), 24000);
      await new Promise((r) => setTimeout(r, 100));
    });

    const { chatHistory } = useStore.getState();
    const texts = chatHistory.map((m) => m.text);
    const unavailable = texts.find((t) => t.includes('live transcript unavailable'));
    expect(unavailable).toBeDefined();
    expect(unavailable).toContain('transcriber down');

    // After cutoff, transcribeChunk should not be called again.
    const callsBefore = provider.transcribeChunk.mock.calls.length;
    await act(async () => {
      result.current.onLiveChunk(makeBlob('e'), 32000);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(provider.transcribeChunk.mock.calls.length).toBe(callsBefore);
  });

  it('finish() stops processing', async () => {
    const provider = makeProvider(async () => 'text');

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 1000 }),
    );

    act(() => {
      result.current.finish();
    });

    await act(async () => {
      result.current.onLiveChunk(makeBlob(), 0);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(provider.transcribeChunk).not.toHaveBeenCalled();
  });

  it('each chat message has a unique id and the configured speaker attribution', async () => {
    let counter = 0;
    const provider = makeProvider(async () => `text-${++counter}`);

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 12345, speakerId: 'user-1', speakerName: 'Alice' }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob(), 0);
      result.current.onLiveChunk(makeBlob(), 8000);
      await new Promise((r) => setTimeout(r, 50));
    });

    const { chatHistory } = useStore.getState();
    expect(chatHistory).toHaveLength(2);
    expect(chatHistory[0].id).toBe('live-12345-0');
    expect(chatHistory[1].id).toBe('live-12345-1');
    expect(chatHistory[0].speakerName).toBe('Alice');
    expect(chatHistory[0].speakerId).toBe('user-1');
    expect(chatHistory[0].offsetMs).toBe(0);
    expect(chatHistory[1].offsetMs).toBe(8000);
    expect(chatHistory[0].agentId).toBe('live-transcript');
  });

  it('falls back to speakerName "Meeting" when no speaker is configured', async () => {
    const provider = makeProvider(async () => 'text');

    const { result } = renderHook(() =>
      useLiveTranscript({ provider, recordingStartMs: 12345 }),
    );

    await act(async () => {
      result.current.onLiveChunk(makeBlob(), 0);
      await new Promise((r) => setTimeout(r, 50));
    });

    const { chatHistory } = useStore.getState();
    expect(chatHistory).toHaveLength(1);
    expect(chatHistory[0].speakerName).toBe('Meeting');
    expect(chatHistory[0].speakerId).toBeUndefined();
  });
});
