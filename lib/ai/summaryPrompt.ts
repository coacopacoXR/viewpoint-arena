// The meeting → minutes prompt (plan 14, batch BF: the third AI job).
//
// capture-service/capture_service/prompt.py holds a hand-copy of
// SUMMARY_SYSTEM_PROMPT and of buildSummaryUserPrompt's layout, because the two
// runtimes have no common module format. The TypeScript here is the authority:
// change it first, then re-copy it. capture-service/tests/
// test_typescript_parity.py fails until the Python copy matches.
//
// Deliberately NOT a JSON-schema-constrained prompt. The answer is markdown
// that a person reads, so the model is asked for markdown and the caller
// validates only that a non-empty string came back — there is no envelope for
// a parser to reject, and inventing one would put a JSON round trip between
// the model and the reader for no gain.

import type { InsightCard } from '../../types';
import type { TranscriptChunk } from '../connectors/capture/types';

export const SUMMARY_SYSTEM_PROMPT = `You are the minute-taker of a CAD design-review tool.

You are given a real review meeting's transcript and the insight cards the app already extracted from it. Write the meeting's minutes.

OUTPUT FORMAT — this is a hard requirement:
Reply with Markdown and nothing else. No preamble, no closing remark, no code fence around the whole document. Start with a level-2 heading.

Use exactly these sections, in this order, and omit a section only when there is genuinely nothing to put in it:

## What was reviewed
One or two sentences: the product or assembly, and what the meeting was for.

## Decisions
A bullet per decision that was actually taken, with the reasoning the speaker gave. Attribute each one to the person who made it.

## Risks raised
A bullet per risk, with its consequence and any mitigation that was proposed.

## Actions
A bullet per action as "- [ ] task — owner (by date)". Use the owner and date the speakers named; write "unassigned" when nobody was named, and omit the date when none was given.

## Open questions
A bullet per question that was asked and not settled.

Rules:
- Never invent a fact that is not in the transcript or the cards. If nobody said who owns an action, do not guess an owner.
- Never write a person's name, a date or a decision that does not appear in the transcript or the cards. A short input gets short minutes.
- Quote a speaker's own words only when the wording itself matters.
- Use the component names the speakers actually used.
- Write in the past tense and in plain sentences. No marketing language, no "the team collaboratively leveraged".
- Keep it under 600 words. A minute nobody reads is not a minute.`;

/** Cards grouped the way the minutes' sections are ordered. */
const SECTION_ORDER = ['RISK', 'RATIONALE', 'ACTION'] as const;

function formatTranscript(transcript: TranscriptChunk[]): string {
  return transcript
    .map((chunk, i) => {
      const start = formatClock(chunk.startMs);
      const end = formatClock(chunk.endMs);
      return `c${i} [${start}-${end}] ${chunk.speakerId}: ${chunk.text}`;
    })
    .join('\n');
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatCard(card: InsightCard, index: number): string {
  const details = card.details;
  const extras: string[] = [];
  if (details.componentReference) extras.push(`component: ${details.componentReference}`);
  if (details.assignee) extras.push(`assignee: ${details.assignee}`);
  if (details.department) extras.push(`department: ${details.department}`);
  if (details.dueDate) extras.push(`due: ${details.dueDate}`);
  if (details.priority) extras.push(`priority: ${details.priority}`);
  if (details.impact) extras.push(`impact: ${details.impact}`);
  if (details.mitigationStrategy) extras.push(`mitigation: ${details.mitigationStrategy}`);
  if (details.designDriver) extras.push(`driver: ${details.designDriver}`);
  const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : '';
  return `k${index} [${card.type}] ${card.title}: ${card.description}${suffix}`;
}

/**
 * The user half of the summary request.
 *
 * Cards are listed before the transcript on purpose: they are the app's own
 * already-validated reading of the meeting, and a model that has them in front
 * of it while reading the raw transcript attributes actions to the right people
 * far more often than one asked to rediscover them.
 *
 * `title` is the review's own name when there is one. Blank falls back to a
 * generic heading rather than labelling the minutes with an empty string.
 */
export function buildSummaryUserPrompt(
  transcript: TranscriptChunk[],
  cards: InsightCard[],
  title?: string,
): string {
  const lines: string[] = [];
  lines.push(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Meeting: ${title?.trim() || 'Design review'}`);
  lines.push('');

  const grouped = SECTION_ORDER.map((type) => cards.filter((c) => c.type === type));
  const ordered = grouped.flat();
  lines.push(
    ordered.length === 0
      ? 'Insight cards already extracted from this meeting: none.'
      : 'Insight cards already extracted from this meeting:',
  );
  ordered.forEach((card, i) => {
    lines.push(formatCard(card, i));
  });
  lines.push('');

  lines.push(
    transcript.length === 0
      ? 'Transcript: none — write the minutes from the cards alone.'
      : 'Transcript:',
  );
  lines.push(formatTranscript(transcript));

  return lines.join('\n');
}
