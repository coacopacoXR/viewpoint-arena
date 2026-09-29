// The transcript → InsightCard extraction prompt.
//
// Shared by all three transcript-driven providers so that OpenAI, Anthropic
// and Ollama are asked for exactly the same payload and can therefore be
// parsed by exactly the same defensive parser (parseInsightCards.ts). Per
// docs/local-capture-plan.md §"LLM extraction pipeline": one pass over the
// transcript window, fused with the spatial context that was on screen.
//
// Browser-safe: no env access, no secrets, no I/O.

import type {
  ComponentTreeEntry,
  PointingSegmentWire,
  SlideContext,
  TranscriptChunk,
  TranscriptHintLine,
} from './types';

/**
 * The JSON envelope every provider is asked for. `cards` mirrors
 * `InsightCard` in types.ts; `id` and `timestamp` are deliberately NOT
 * requested because the app mints them (a model cannot know the clock and
 * cannot guarantee uniqueness). The parser tolerates them if a model emits
 * them anyway.
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are the insight-capture layer of a CAD design-review tool.

You are given a window of a real review meeting's transcript and the 3D context the speakers were looking at. Extract the durable engineering insights from it as structured data.

Capture exactly three kinds of insight:
- RISK: a concern about the design, with its consequence. Something that could go wrong.
- RATIONALE: why a design decision was made, what drove it, what was traded off.
- ACTION: a task someone committed to or asked for, with an owner or department when one was named.

Do NOT capture small talk, agenda logistics, or restatements of what a slide already says. If the window contains nothing worth capturing, return zero cards.

Never invent a fact that is not in the transcript. Quote the speaker's own reasoning in the description. Use the component names the speakers actually used.

OUTPUT FORMAT — this is a hard requirement:
Reply with a single raw JSON object and nothing else. No markdown, no code fences, no leading or trailing prose, no commentary. The JSON must parse with JSON.parse as-is.

{
  "cards": [
    {
      "type": "RISK" | "RATIONALE" | "ACTION",
      "title": "<= 8 words, a noun phrase naming the insight",
      "description": "1-3 sentences carrying the speaker's actual reasoning",
      "agentId": "the speakerId this insight came from",
      "relatedPoiId": "optional: the component name discussed",
      "sourceMessageIds": ["optional: the chunk labels, e.g. c3, c4"],
      "details": {
        "priority": "Critical" | "High" | "Medium" | "Low",
        "status": "Open",
        "componentReference": "optional: component name from the model tree",
        "impact": "RISK only: what breaks if this is not addressed",
        "mitigationStrategy": "RISK only: what was proposed to reduce it",
        "designDriver": "RATIONALE only: the requirement or goal behind the decision",
        "alternativesConsidered": "RATIONALE only: what else was on the table",
        "tradeoffAnalysis": "RATIONALE only: what was given up",
        "department": "ACTION only: owning department",
        "assignee": "ACTION only: owning person",
        "dueDate": "ACTION only: YYYY-MM-DD. Resolve a relative deadline ("by Friday") against today's date given above the transcript; omit if no deadline was stated",
        "dueDateText": "ACTION only: the deadline exactly as it was spoken ("by Friday", "next week", "end of the month"). Copy the speaker's words verbatim and never convert them into a date; omit if no deadline was stated"
      }
    }
  ]
}

Rules:
- Omit optional fields you have no evidence for. Do not fill them with guesses or empty strings.
- Do not emit "id" or "timestamp"; the application assigns those.
- Do not add any field that is not listed above.
- "priority" is required on every card. Judge it from the speaker's own emphasis: Critical only for safety, yield-blocking or schedule-blocking concerns.
- Whenever a deadline was spoken, fill BOTH date fields: "dueDateText" with the speaker's own words, verbatim, and "dueDate" with your best reading of them. The application resolves "dueDateText" against the calendar it sends with the transcript and prefers that answer, because a copied phrase can be resolved exactly and a date you computed often cannot be.
- When a "Components in this model" list is provided, \`componentReference\` MUST be an id from that list, or omitted entirely. Never invent a component id. Never use a part name that is not in the list.
- When an utterance is deictic ("this", "that", "here") and a pointing segment from the same speaker overlaps its time window, prefer that part as the componentReference.
- Otherwise resolve a spoken component name against the list; if you are unsure which id matches, omit componentReference rather than guess.`;

/** Renders the transcript window with stable per-chunk labels (c0, c1, …). */
export function formatTranscript(transcript: TranscriptChunk[]): string {
  return transcript
    .map((chunk, i) => {
      const start = formatMs(chunk.startMs);
      const end = formatMs(chunk.endMs);
      return `c${i} [${start}-${end}] ${chunk.speakerId}: ${chunk.text}`;
    })
    .join('\n');
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** English weekday of a YYYY-MM-DD date, independent of locale and timezone. */
export function weekdayOf(isoDate: string): string {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()] ?? 'unknown';
}

/** "Tuesday 2026-09-22, Wednesday 2026-09-23, …" for the `count` days after isoDate. */
export function upcomingDays(isoDate: string, count: number): string {
  const start = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return 'unknown';
  const days: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    days.push(`${weekdayOf(d)} ${d}`);
  }
  return days.join(', ');
}

/**
 * Builds the user turn: spatial context first (so the model can attribute a
 * comment to the part that was on screen), then the component list, pointing
 * segments and transcript hint when supplied, then the labelled transcript.
 */
export function buildExtractionUserPrompt(
  transcript: TranscriptChunk[],
  context: SlideContext,
  today: string = new Date().toISOString().slice(0, 10),
  grounded?: {
    components?: ComponentTreeEntry[];
    pointingSegments?: PointingSegmentWire[];
    transcriptHint?: TranscriptHintLine[];
  },
): string {
  // Today's date plus a two-week calendar lets the model turn "by Friday" into
  // a real date by LOOKUP rather than arithmetic. Live runs with qwen2.5:7b:
  // no date -> wrong year (2023-10-06); date + weekday -> right year, wrong day
  // every time (2026-09-28 for a Monday's "by Friday"). Small models do date
  // arithmetic badly and table lookup well.
  const lines = [
    `Today's date: ${today} (${weekdayOf(today)})`,
    `Next 14 days: ${upcomingDays(today, 14)}`,
    `Agenda item ${context.agendaIdx}: ${context.slideTitle}`,
  ];
  if (context.hoveredPartName) {
    lines.push(`A speaker was hovering over: ${context.hoveredPartName}`);
  }
  if (context.laserTargetPartName) {
    lines.push(`The laser pointer was on: ${context.laserTargetPartName}`);
  }

  if (grounded?.components && grounded.components.length > 0) {
    lines.push('', 'Components in this model:');
    for (const c of grounded.components) {
      lines.push(`${c.id} · ${c.path}`);
    }
  }

  if (grounded?.pointingSegments && grounded.pointingSegments.length > 0) {
    lines.push('', 'What people were pointing at:');
    for (const seg of grounded.pointingSegments) {
      const fromSec = Math.round(seg.fromMs / 1000);
      const toSec = Math.round(seg.toMs / 1000);
      lines.push(`${seg.userName} → ${seg.partName} (${fromSec}s–${toSec}s)`);
    }
  }

  if (grounded?.transcriptHint && grounded.transcriptHint.length > 0) {
    lines.push('', 'Speaker transcript (attribution hint — Whisper transcript is the source for extraction):');
    for (const line of grounded.transcriptHint) {
      const sec = Math.round(line.offsetMs / 1000);
      lines.push(`[${line.speaker}, t=${sec}s] ${line.text}`);
    }
  }

  lines.push('', 'Transcript window:', formatTranscript(transcript));
  return lines.join('\n');
}
