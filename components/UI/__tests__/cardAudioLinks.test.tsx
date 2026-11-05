// A card's "Linked components" row — components/UI/CardAudioLinks.tsx.
//
// Task 09b. The maths behind the row is pinned in lib/capture/__tests__/cardComponents.test.ts;
// what is pinned here is the row itself: that a card with links draws chips and timestamps,
// that a card without them draws nothing at all, that a chip takes the select path the Model
// Tree takes, that a timestamp takes the host's scroll-to-message routine, and that the ▶ is
// offered only when this browser is still holding the recording the span is an offset into.
//
// The row is rendered on its own rather than through the Capture panel; the wiring between
// the two is components/UI/__tests__/conversationPanelAudioLinks.test.tsx.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import CardAudioLinks, { pointedHint } from '../CardAudioLinks';
import { useKeptRecordingStore } from '../../../lib/capture/keptRecordingStore';
import type { PointingSegment } from '../../../lib/pointingTimelineStore';
import type { ChatMessage, InsightCard } from '../../../types';

const RECORDING_START = 1_700_000_000_000;
const KEPT_URL = 'blob:kept-recording';

/**
 * The `<audio>` the row drives, as a fake.
 *
 * jsdom has an HTMLMediaElement but no implementation behind it — `play()` is a
 * not-implemented stub and a src assignment loads nothing — so a real element could only
 * ever prove that the row did not throw. This records what the row asked of it, which is
 * the whole of the behaviour worth pinning: where it seeked to, that it played, and that it
 * stopped at the end of the span rather than at the end of the meeting.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = '';
  currentTime = 0;
  seekedAndPlayed: number[] = [];
  pauses = 0;
  private listeners = new Map<string, Array<() => void>>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((entry) => entry !== handler));
  }

  play(): Promise<void> {
    this.seekedAndPlayed.push(this.currentTime);
    return Promise.resolve();
  }

  pause(): void {
    this.pauses += 1;
    this.emit('pause');
  }

  /** What a browser would fire, fired by the test instead. */
  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler();
  }
}

function line(offsetMs: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `live-${RECORDING_START}-${offsetMs}`,
    agentId: '',
    text: 'the pin wears through the bush',
    timestamp: RECORDING_START + offsetMs,
    speakerId: 'maria',
    speakerName: 'Maria',
    offsetMs,
    ...overrides,
  };
}

function segment(fromMs: number, toMs: number, overrides: Partial<PointingSegment> = {}): PointingSegment {
  return {
    userId: 'maria',
    userName: 'Maria',
    partId: 'node-14',
    partName: 'Left Ear Cup',
    source: 'laser',
    fromMs,
    toMs,
    ...overrides,
  };
}

function card(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'insight-1',
    type: 'RISK',
    agentId: '1',
    title: 'Clearance too tight',
    description: 'It will not assemble.',
    timestamp: RECORDING_START,
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

/** One line at 96 s with Maria on the ear cup for the first six of its eight seconds. */
const LINE_96S = line(96_000);
const POINTING = [segment(96_000, 102_000)];
const PART_NAMES = { 'node-14': 'Left Ear Cup', 'node-22': 'Headband' };
const KNOWN_PARTS = { 'node-14': {}, 'node-22': {} };

function renderRow(overrides: Partial<React.ComponentProps<typeof CardAudioLinks>> = {}) {
  const onSelectPart = vi.fn();
  const onScrollToMessage = vi.fn();
  const view = render(
    <CardAudioLinks
      card={card({ sourceMessageIds: [LINE_96S.id] })}
      messages={[LINE_96S]}
      segments={POINTING}
      partNames={PART_NAMES}
      knownParts={KNOWN_PARTS}
      onSelectPart={onSelectPart}
      onScrollToMessage={onScrollToMessage}
      {...overrides}
    />,
  );
  return { ...view, onSelectPart, onScrollToMessage };
}

function keepRecording(startedAt: number = RECORDING_START, url: string = KEPT_URL): void {
  act(() => {
    useKeptRecordingStore.setState({ recording: { startedAt, url } });
  });
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => {
    useKeptRecordingStore.setState({ recording: null });
  });
});

describe('a card with links', () => {
  it('draws a chip per part and a timestamp per span', () => {
    renderRow();

    expect(screen.getByTestId('card-audio-links')).toBeTruthy();
    expect(screen.getByText('Linked components')).toBeTruthy();
    expect(screen.getByTestId('linked-component')).toBeTruthy();
    expect(screen.getByText('Left Ear Cup')).toBeTruthy();
    expect(screen.getByTestId('linked-span')).toHaveTextContent('01:36–01:44');
  });

  it('says who pointed at the part and for how long', () => {
    renderRow();
    expect(screen.getByText('pointed by Maria, 00:06')).toBeTruthy();
  });

  it('says when the model named the part as well as somebody pointing at it', () => {
    renderRow({
      card: card({
        sourceMessageIds: [LINE_96S.id],
        details: { priority: 'High', status: 'Open', componentReference: 'node-14' },
      }),
    });

    expect(screen.getByText('pointed by Maria, 00:06 · named by the model')).toBeTruthy();
    // One part, one chip: the two are the same fact about the same mesh.
    expect(screen.getAllByTestId('linked-component')).toHaveLength(1);
  });

  it('says "named by the model" on its own for a part nobody pointed at', () => {
    renderRow({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'node-22' } }),
      messages: [],
      segments: [],
    });

    expect(screen.getByText('Headband')).toBeTruthy();
    expect(screen.getByText('named by the model')).toBeTruthy();
    expect(screen.queryByText(/pointed by/)).toBeNull();
  });

  it('draws a timestamp per source line, in the order they were said', () => {
    const late = line(200_000);
    renderRow({
      card: card({ sourceMessageIds: [late.id, LINE_96S.id] }),
      messages: [LINE_96S, late],
      segments: [],
    });

    const spans = screen.getAllByTestId('linked-span').map((el) => el.textContent);
    expect(spans).toEqual(['01:36–01:44', '03:20–03:28']);
  });
});

describe('a card with no links', () => {
  it('draws no row at all', () => {
    renderRow({ card: card(), messages: [LINE_96S], segments: POINTING });

    expect(screen.queryByTestId('card-audio-links')).toBeNull();
    expect(screen.queryByText('Linked components')).toBeNull();
  });

  it('draws no row for a card whose source line the room no longer holds', () => {
    renderRow({ card: card({ sourceMessageIds: ['live-1-2'] }), messages: [LINE_96S] });

    expect(screen.queryByTestId('card-audio-links')).toBeNull();
  });

  it('draws no row for a card whose source line has no timestamp', () => {
    const systemLine = line(96_000, { id: 'system-gap', offsetMs: undefined, speakerId: undefined });
    renderRow({ card: card({ sourceMessageIds: [systemLine.id] }), messages: [systemLine] });

    expect(screen.queryByTestId('card-audio-links')).toBeNull();
  });

  it('still draws the span for a card nobody was pointing during', () => {
    // The audio the card came from is worth hearing even when no laser was on anything.
    renderRow({ segments: [] });

    expect(screen.queryByTestId('linked-component')).toBeNull();
    expect(screen.getByTestId('linked-span')).toBeTruthy();
  });
});

describe('a hand-made card', () => {
  it('shows its component and no spans', () => {
    renderRow({
      card: card({
        agentId: '',
        source: 'manual',
        createdByName: 'Maria Okafor',
        details: { priority: 'Medium', status: 'Open', componentReference: 'node-22' },
      }),
      messages: [LINE_96S],
    });

    expect(screen.getByText('Headband')).toBeTruthy();
    // A person chose this part, not a model, and the card's own footer says who.
    expect(screen.getByText('named on the card')).toBeTruthy();
    expect(screen.queryByText('named by the model')).toBeNull();
    expect(screen.queryByTestId('linked-span')).toBeNull();
  });
});

describe('a part that is no longer in the scene', () => {
  it('keeps the name and offers no click', () => {
    renderRow({
      card: card({ details: { priority: 'High', status: 'Open', componentReference: 'node-22' } }),
      knownParts: { 'node-14': {} },
      messages: [],
      segments: [],
    });

    const missing = screen.getByTestId('linked-component-missing');
    expect(missing).toHaveTextContent('Headband');
    expect(missing.getAttribute('title')).toBe('Headband is not in the scene any more');
    expect(screen.queryByTestId('linked-component')).toBeNull();
  });
});

describe('clicking a chip', () => {
  it('takes the select path a Model Tree row takes', () => {
    const { onSelectPart } = renderRow();

    fireEvent.click(screen.getByTestId('linked-component'));
    expect(onSelectPart).toHaveBeenCalledWith('node-14');
  });

  it('does not also open the card, which is what a click on the card itself means', () => {
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <CardAudioLinks
          card={card({ sourceMessageIds: [LINE_96S.id] })}
          messages={[LINE_96S]}
          segments={POINTING}
          partNames={PART_NAMES}
          knownParts={KNOWN_PARTS}
          onSelectPart={() => {}}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId('linked-component'));
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

describe('clicking a timestamp', () => {
  it('asks the host to scroll the transcript to that line', () => {
    const { onScrollToMessage } = renderRow();

    fireEvent.click(screen.getByTestId('linked-span'));
    expect(onScrollToMessage).toHaveBeenCalledWith(LINE_96S.id);
  });

  it('is a label rather than a button where the host has no transcript on screen', () => {
    renderRow({ onScrollToMessage: undefined });

    expect(screen.queryByTestId('linked-span')).toBeNull();
    expect(screen.getByText('01:36–01:44')).toBeTruthy();
  });

  it('names the speaker in the full view, where there is room', () => {
    renderRow({ variant: 'full' });

    expect(screen.getByText('Maria')).toBeTruthy();
    expect(screen.getByTestId('linked-span').getAttribute('title')).toContain('Maria');
  });
});

describe('playing the clip back', () => {
  it('offers no ▶ while this browser holds no recording', () => {
    renderRow();
    expect(screen.queryByTestId('linked-span-play')).toBeNull();
  });

  it('offers a ▶ once the recording is still in the browser', () => {
    keepRecording();
    renderRow();
    expect(screen.getByTestId('linked-span-play')).toBeTruthy();
  });

  it('does not offer one for a span from a DIFFERENT recording', () => {
    // Only the latest recording is kept, so a ▶ here would play the wrong minute of audio.
    keepRecording(RECORDING_START + 1);
    renderRow();
    expect(screen.queryByTestId('linked-span-play')).toBeNull();
  });

  it('seeks to the span and plays it', () => {
    keepRecording();
    renderRow();

    fireEvent.click(screen.getByTestId('linked-span-play'));
    const audio = FakeAudio.instances[0];
    expect(audio.src).toBe(KEPT_URL);
    // The browser throws away a `currentTime` written before it knows the duration, so the
    // row waits for the metadata rather than writing into nothing.
    expect(audio.seekedAndPlayed).toEqual([]);

    act(() => audio.emit('loadedmetadata'));
    expect(audio.currentTime).toBe(96);
    expect(audio.seekedAndPlayed).toEqual([96]);
  });

  it('stops at the end of the span, not at the end of the meeting', () => {
    keepRecording();
    renderRow();
    fireEvent.click(screen.getByTestId('linked-span-play'));
    const audio = FakeAudio.instances[0];
    act(() => audio.emit('loadedmetadata'));

    audio.currentTime = 100;
    act(() => audio.emit('timeupdate'));
    expect(audio.pauses).toBe(0);

    audio.currentTime = 104;
    act(() => audio.emit('timeupdate'));
    expect(audio.pauses).toBe(1);
    // The row reads "play" again rather than claiming to be playing something it stopped.
    expect(screen.getByTestId('linked-span-play').getAttribute('title')).toBe('Play what was said here');
  });

  it('plays a second span through the same element rather than opening a second one', () => {
    keepRecording();
    const second = line(200_000);
    renderRow({
      card: card({ sourceMessageIds: [LINE_96S.id, second.id] }),
      messages: [LINE_96S, second],
    });

    const [first, next] = screen.getAllByTestId('linked-span-play');
    fireEvent.click(first);
    act(() => FakeAudio.instances[0].emit('loadedmetadata'));
    fireEvent.click(next);

    expect(FakeAudio.instances).toHaveLength(1);
    // The url is already loaded, so the second press seeks straight away.
    expect(FakeAudio.instances[0].seekedAndPlayed).toEqual([96, 200]);
  });

  it('plays the span pressed last when two are pressed before the recording has loaded', () => {
    keepRecording();
    const second = line(200_000);
    renderRow({
      card: card({ sourceMessageIds: [LINE_96S.id, second.id] }),
      messages: [LINE_96S, second],
    });

    const [first, next] = screen.getAllByTestId('linked-span-play');
    fireEvent.click(first);
    // No metadata yet, so the first press is still waiting to seek.
    fireEvent.click(next);
    act(() => FakeAudio.instances[0].emit('loadedmetadata'));

    expect(FakeAudio.instances[0].seekedAndPlayed).toEqual([200]);
  });

  it('starts a new element when a second recording replaces the one it was pointed at', () => {
    keepRecording(RECORDING_START, 'blob:first');
    renderRow();
    fireEvent.click(screen.getByTestId('linked-span-play'));
    expect(FakeAudio.instances).toHaveLength(1);

    keepRecording(RECORDING_START, 'blob:second');
    fireEvent.click(screen.getByTestId('linked-span-play'));

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].src).toBe('blob:second');
    expect(FakeAudio.instances[0].pauses).toBe(1);
  });

  it('stops when the row goes away', () => {
    keepRecording();
    const { unmount } = renderRow();
    fireEvent.click(screen.getByTestId('linked-span-play'));
    const audio = FakeAudio.instances[0];

    unmount();
    expect(audio.pauses).toBe(1);
  });
});

describe('the hint on a chip', () => {
  it('names the person who pointed longest, and how long for', () => {
    expect(pointedHint([{ userName: 'Maria', ms: 6_000 }])).toBe('pointed by Maria, 00:06');
  });

  it('counts the others rather than listing them, in a chip nine pixels tall', () => {
    expect(
      pointedHint([
        { userName: 'Maria', ms: 6_000 },
        { userName: 'Pete', ms: 2_000 },
        { userName: 'Olga', ms: 1_000 },
      ]),
    ).toBe('pointed by Maria +2, 00:06');
  });

  it('says "somebody" for a pointer with no name on it', () => {
    expect(pointedHint([{ userName: '', ms: 1_000 }])).toBe('pointed by somebody, 00:01');
  });

  it('says nothing for a part nobody pointed at', () => {
    expect(pointedHint([])).toBe('');
  });
});
