// A meeting's transcript as text, and the file it is downloaded as.
//
// docs/plan/15-sessions-and-variants.md batch BU. Stopping a recording used to
// mean "send the audio for card extraction", and that was the only thing anybody
// could do with an hour of design review. Now it is one of three choices, and two
// of them are the transcript itself: a .txt the person who recorded it can keep,
// and the same transcript stored on the meeting's tracker_sessions row so the
// session map can offer it weeks later.
//
// ONE function renders both, because a transcript that reads differently
// depending on where it was downloaded from is two formats and nobody remembers
// which is which. The rows it takes are the rows the database stores, so the .txt
// from the stop panel and the .txt from the session map are byte-identical for the
// same meeting — including what people were pointing at, when that was asked for.
//
// This module imports NOTHING at runtime: the types and the guards live here so
// that a component which only renders a transcript (components/review/SessionMap)
// does not pull in the capture path, supabase, or the store.

/** Somebody said something, this many milliseconds into the recording. */
export interface TranscriptSpeech {
  t: number;
  speaker: string;
  text: string;
}

/**
 * Somebody was pointing at a part, from `t` until `untilMs`.
 *
 * A row of its own rather than a field on the speech row because it is not
 * attached to one: a person can point at the hinge pin for eleven seconds without
 * saying anything, and the question the .txt answers is "where were they pointing
 * at", which is a span and not a property of a sentence.
 */
export interface TranscriptPointing {
  t: number;
  speaker: string;
  pointing: string;
  untilMs: number;
}

export type TranscriptLine = TranscriptSpeech | TranscriptPointing;

/**
 * One row of the stored array. The last row of a transcript that hit the cap is
 * `{ truncated: true }` — a marker rather than a dropped tail, so a reader of the
 * .txt is told the meeting went on and the record did not.
 */
export type TranscriptRow = TranscriptLine | { truncated: true };

export function isTranscriptSpeech(row: TranscriptRow): row is TranscriptSpeech {
  return 'text' in row;
}

export function isTranscriptPointing(row: TranscriptRow): row is TranscriptPointing {
  return 'pointing' in row;
}

export function isTranscriptTruncated(row: TranscriptRow): row is { truncated: true } {
  return 'truncated' in row && row.truncated === true;
}

/** How many lines of the transcript somebody said: what "Transcript · 214 lines" counts. */
export function transcriptLineCount(rows: readonly TranscriptRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (isTranscriptSpeech(row)) count += 1;
  }
  return count;
}

/**
 * Read the jsonb column back into rows.
 *
 * Tolerant the way lib/reviews/linesRepo.toLineSession is: a row this code does
 * not recognise is dropped rather than throwing, because the alternative is a
 * session panel that cannot open at all — and a meeting's transcript is the least
 * important thing in it. Answers null (and not []) for a column that is absent,
 * NULL, or not an array, which is every session recorded before this batch and
 * every session whose meeting nobody asked to keep.
 */
export function parseTranscriptRows(value: unknown): TranscriptRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: TranscriptRow[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const t = typeof record['t'] === 'number' && Number.isFinite(record['t']) ? record['t'] : null;
    const speaker = typeof record['speaker'] === 'string' ? record['speaker'] : '';
    if (record['truncated'] === true) {
      rows.push({ truncated: true });
      continue;
    }
    if (t === null || speaker === '') continue;
    if (typeof record['text'] === 'string' && record['text'] !== '') {
      rows.push({ t, speaker, text: record['text'] });
      continue;
    }
    if (typeof record['pointing'] === 'string' && record['pointing'] !== '') {
      const untilMs =
        typeof record['untilMs'] === 'number' && Number.isFinite(record['untilMs'])
          ? record['untilMs']
          : t;
      rows.push({ t, speaker, pointing: record['pointing'], untilMs });
    }
  }
  return rows;
}

/** `[00:00:04]` without the brackets — hours are not capped, a long meeting is a long meeting. */
export function transcriptClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export interface TranscriptTextOptions {
  /** Render the pointing rows. Off, and they are skipped rather than removed. */
  includePointing?: boolean;
  /** The design review's name, for the heading. */
  title?: string | null;
  /** Already formatted by the caller ("25 Sep 2026"), so a test can pin it. */
  date?: string | null;
  /** Who was in the room, in the order the room knew them. */
  attendees?: readonly string[];
}

const TRUNCATION_NOTE = 'The transcript was cut short here: it reached the stored limit.';

/**
 * The transcript as a .txt.
 *
 * `\n` line endings and UTF-8 (the Blob's charset) on purpose: the file is read in
 * Notepad, in a diff and in an email, and `\r\n` shows up as `^M` in two of those
 * three. Every offset is printed as a clock rather than as milliseconds because the
 * person reading it is looking for "the moment Ben said the pin wears", and
 * `[00:00:15]` is findable in a player's scrub bar where `15000` is not.
 */
export function transcriptToText(
  lines: readonly TranscriptRow[],
  options: TranscriptTextOptions = {},
): string {
  const includePointing = options.includePointing === true;
  const title = (options.title ?? '').trim();
  const date = (options.date ?? '').trim();
  const attendees = (options.attendees ?? []).map((name) => name.trim()).filter((name) => name !== '');

  const heading = title !== '' && date !== '' ? `${title} — ${date}` : title !== '' ? title : date;
  const header: string[] = [];
  if (heading !== '') header.push(heading);
  if (attendees.length > 0) header.push(`Attendees: ${attendees.join(', ')}`);

  const body: string[] = [];
  let truncated = false;
  for (const row of lines) {
    if (isTranscriptTruncated(row)) {
      truncated = true;
      continue;
    }
    if (isTranscriptSpeech(row)) {
      body.push(`[${transcriptClock(row.t)}] ${row.speaker}: ${row.text}`);
      continue;
    }
    if (!includePointing) continue;
    // Indented under the line it happened beside: it is context for what was
    // being said, not a third thing that was said.
    body.push(
      `[${transcriptClock(row.t)}]   (${row.speaker} pointing at: ${row.pointing}, ` +
        `${transcriptClock(row.t)}–${transcriptClock(row.untilMs)})`,
    );
  }
  if (truncated) body.push(TRUNCATION_NOTE);

  return header.length > 0 ? `${header.join('\n')}\n\n${body.join('\n')}\n` : `${body.join('\n')}\n`;
}

// What a file system refuses in a name. Backslash and forward slash (both, because
// the file is downloaded on Windows and read on Linux), the four characters cmd.exe
// gives a meaning, the two Windows reserves, the pipe, and the control characters a
// name can only get from a model's output.
const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_FILENAME_STEM = 120;

/**
 * The date as the transcript's heading and filename want it: "25 Sep 2026".
 *
 * Written out rather than asked of `toLocaleDateString`, which is what the rest of
 * the app uses for a session's title, for one reason: the answer depends on the
 * platform's ICU data, and current CLDR spells en-GB's short September "Sept" where
 * an older one spelled it "Sep". A heading is a small thing to have differ between
 * two browsers, but this one is also in a FILENAME, and a file whose name depends on
 * which machine downloaded it is a file two people cannot find in the same folder.
 *
 * Local time, like every other date this app shows: the meeting happened on the day
 * the people in it were in.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTranscriptDate(when: Date): string {
  if (Number.isNaN(when.getTime())) return '';
  return `${when.getDate()} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`;
}

/**
 * `<review name> — <date> transcript.txt`, safe to write on any file system.
 *
 * Sanitised rather than refused: a review named "Hinge/pin: rev C?" is a name
 * somebody typed and it still has to download, so the characters that cannot be in
 * a file name become a dash and the rest survives. A trailing dot or space is
 * dropped because Windows removes it silently and the file then has a different
 * name from the one the browser showed.
 */
export function transcriptFilename(title?: string | null, date?: string | null): string {
  const stem = [title, date]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' — ');
  const cleaned = (stem === '' ? 'Meeting' : stem)
    .replace(ILLEGAL_FILENAME, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_FILENAME_STEM)
    .replace(/[\s.]+$/g, '');
  return `${cleaned === '' ? 'Meeting' : cleaned} transcript.txt`;
}

/**
 * Hand the text to the browser as a file.
 *
 * A Blob, an object URL and a temporary `<a download>` that is clicked and
 * removed: the only way to offer a download from a page that has no server round
 * trip to make, and the transcript of a design review is exactly the thing that
 * should not make one. The URL is revoked on the next turn rather than inline,
 * because revoking it before the browser has started reading the blob cancels the
 * download in some browsers.
 *
 * Answers false where there is no DOM to download into, which is a test and
 * nothing else; callers show the reason rather than pretending the file arrived.
 */
export function downloadTranscript(text: string, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
