import { describe, expect, it } from 'vitest';
import {
  buildExtractionUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  upcomingDays,
  weekdayOf,
} from './extractionPrompt';
import type { ComponentTreeEntry, PointingSegmentWire, TranscriptHintLine } from './types';

const chunk = { speakerId: 'speaker-1', text: 'Ship it by Friday.', startMs: 0, endMs: 4000 };

describe('buildExtractionUserPrompt', () => {
  it("puts today's date and weekday first, then the agenda line", () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 2, slideTitle: 'Bracket' },
      '2026-09-21',
    );
    const lines = prompt.split('\n');
    expect(lines[0]).toBe("Today's date: 2026-09-21 (Monday)");
    expect(lines[1]).toBe(`Next 14 days: ${upcomingDays('2026-09-21', 14)}`);
    expect(lines[2]).toBe('Agenda item 2: Bracket');
  });

  it('lists the next two weeks so "by Friday" is a lookup, not arithmetic', () => {
    const days = upcomingDays('2026-09-21', 14).split(', ');
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('Tuesday 2026-09-22');
    expect(days).toContain('Friday 2026-09-25');
    expect(days[13]).toBe('Monday 2026-10-05');
    expect(upcomingDays('nope', 3)).toBe('unknown');
  });

  it("defaults to today's UTC date", () => {
    const prompt = buildExtractionUserPrompt([chunk], { agendaIdx: 0, slideTitle: 'x' });
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt.split('\n')[0]).toBe(`Today's date: ${today} (${weekdayOf(today)})`);
  });

  it('names the weekday the same way in every locale and timezone', () => {
    expect(weekdayOf('2026-09-21')).toBe('Monday');
    expect(weekdayOf('2026-09-25')).toBe('Friday');
    expect(weekdayOf('2024-02-29')).toBe('Thursday');
    expect(weekdayOf('not-a-date')).toBe('unknown');
  });

  it('tells the model to resolve relative deadlines against that date', () => {
    // A live run without this turned "by Friday" into 2023-10-06.
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("against today's date");
  });
});

describe('buildExtractionUserPrompt — grounded sections', () => {
  const components: ComponentTreeEntry[] = [
    { id: 'headphones_assembly', name: 'Headphones', path: 'Headphones' },
    { id: 'left_cup', name: 'Left Ear Cup', path: 'Headphones / Left Ear Cup' },
    { id: 'left_cushion', name: 'Left Ear Cushion', path: 'Headphones / Left Ear Cup / Left Ear Cushion' },
  ];

  const pointingSegments: PointingSegmentWire[] = [
    { userId: 'u1', userName: 'Alice', partId: 'left_cushion', partName: 'Left Ear Cushion', fromMs: 5000, toMs: 12000 },
  ];

  const transcriptHint: TranscriptHintLine[] = [
    { speaker: 'Alice', text: 'This cushion here feels too thin.', offsetMs: 8000 },
  ];

  it('renders the component list when supplied', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
      { components },
    );
    expect(prompt).toContain('Components in this model:');
    expect(prompt).toContain('left_cup · Headphones / Left Ear Cup');
    expect(prompt).toContain('left_cushion · Headphones / Left Ear Cup / Left Ear Cushion');
  });

  it('renders pointing segments with seconds', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
      { pointingSegments },
    );
    expect(prompt).toContain('What people were pointing at:');
    expect(prompt).toContain('Alice → Left Ear Cushion (5s–12s)');
  });

  it('renders the transcript hint with speaker and t=seconds', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
      { transcriptHint },
    );
    expect(prompt).toContain('Speaker transcript (attribution hint');
    expect(prompt).toContain('[Alice, t=8s] This cushion here feels too thin.');
  });

  it('renders all three sections in order when all are supplied', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
      { components, pointingSegments, transcriptHint },
    );
    const compIdx = prompt.indexOf('Components in this model:');
    const pointIdx = prompt.indexOf('What people were pointing at:');
    const hintIdx = prompt.indexOf('Speaker transcript');
    const transcriptIdx = prompt.indexOf('Transcript window:');
    expect(compIdx).toBeGreaterThan(-1);
    expect(pointIdx).toBeGreaterThan(compIdx);
    expect(hintIdx).toBeGreaterThan(pointIdx);
    expect(transcriptIdx).toBeGreaterThan(hintIdx);
  });

  it('omits all three sections when grounded is undefined', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
    );
    expect(prompt).not.toContain('Components in this model:');
    expect(prompt).not.toContain('What people were pointing at:');
    expect(prompt).not.toContain('Speaker transcript');
  });

  it('omits a section when its array is empty', () => {
    const prompt = buildExtractionUserPrompt(
      [chunk],
      { agendaIdx: 0, slideTitle: 'Review' },
      '2026-09-23',
      { components: [], pointingSegments: [], transcriptHint: [] },
    );
    expect(prompt).not.toContain('Components in this model:');
    expect(prompt).not.toContain('What people were pointing at:');
    expect(prompt).not.toContain('Speaker transcript');
  });
});

describe('EXTRACTION_SYSTEM_PROMPT — grounded rules', () => {
  it('requires componentReference to be an id from the list', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('componentReference');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('MUST be an id from');
  });

  it('tells the model to prefer pointing segments for deictic references', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('deictic');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('pointing segment');
  });

  it('tells the model to omit rather than guess when unsure', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('if you are unsure');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('omit componentReference');
  });
});

describe('EXTRACTION_SYSTEM_PROMPT — deadlines', () => {
  // The built-in 7B model gets "by Friday" wrong even with a fortnight of
  // weekday names in the prompt to look it up in, so the app resolves the phrase
  // itself (lib/capture/resolveDeadline.ts). That only works if the model is
  // asked for the WORDS, verbatim, alongside the date it computed.
  it('asks for the spoken phrase as well as the date', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('"dueDateText"');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('exactly as it was spoken');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('verbatim');
  });

  it('says which of the two fields the application prefers', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('fill BOTH date fields');
  });

  it('asks only for keys the constrained Ollama decoder also allows', async () => {
    // additionalProperties is false in the schema, so a field the prompt asks
    // for and the schema does not allow is a field Ollama can never send — the
    // prompt would be asking for something structurally impossible.
    const { default: schema } = await import('./extractionSchema.json');
    const details = schema.properties.cards.items.properties.details;
    expect(Object.keys(details.properties)).toContain('dueDateText');
    expect(details.additionalProperties).toBe(false);
  });
});
