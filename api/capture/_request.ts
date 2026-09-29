// Shared request-side helpers for the /api/capture/* endpoints (plan 14, BF).
//
// These four handlers — extract, local, transcribe and summary — all accept the
// same two shapes (a SlideContext and the optional grounded-capture context), all
// hand their work to lib/ai/router.ts, and all have to turn a router failure into
// a response body that leaks nothing. Doing that three or four times over is how
// one of them ends up forwarding `err.message`.
//
// The rules every function here enforces are the ones in
// api/capture/extract.ts's security header: a transcript is never echoed, model
// output is never echoed, a credential is never echoed, and an unknown field is
// refused rather than ignored.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requestIsUnlocked } from '../_lib/accessControl.ts';
import { BodyTooLargeError, readRawBodyLimited } from '../_lib/rawBody.ts';
import type {
  ComponentTreeEntry,
  GroundedCaptureContext,
  PointingSegmentWire,
  SlideContext,
  TranscriptChunk,
  TranscriptHintLine,
} from '../../lib/connectors/capture/types.ts';
import { asAiJobError } from '../../lib/ai/router.ts';

/**
 * The front-door gate every capture endpoint sits behind.
 *
 * These routes SPEND something — a GPU, a cloud API key, an enterprise gateway's
 * quota — and they attach their own upstream credential for every caller. Without
 * this check, anyone who could reach the origin could make the deployment
 * transcribe audio or bill a provider without ever seeing a screen. In the
 * self-hosted stack nginx enforces the same thing first (deploy/nginx/app.conf's
 * /_access_check subrequest), so this is the second of two doors rather than the
 * only one — which matters on Vercel, where there is no nginx.
 *
 * Sends the 401 itself and returns false, so a handler reads
 * `if (!enforceCaptureAccess(req, res)) return;` and cannot forget the early exit.
 */
export function enforceCaptureAccess(req: VercelRequest, res: VercelResponse): boolean {
  if (!requestIsUnlocked(req as unknown as { cookies?: Record<string, string> })) {
    res.status(401).json({ error: 'locked' });
    return false;
  }
  return true;
}

/**
 * Read a capture request's raw body, answering the two ways it can go wrong.
 *
 * The ceiling is enforced HERE rather than left to nginx or to the upstream,
 * because the body is no longer forwarded untouched: this runtime parses it, so
 * this runtime is the layer that has to say "too big" — and say it before it has
 * accepted 200 MB it cannot hold. readRawBodyLimited keeps draining the socket
 * after refusing so the 413 can actually be delivered.
 *
 * Returns null once it has answered, so the caller's shape is
 * `const raw = await readCaptureBody(…); if (raw === null) return;`.
 */
export async function readCaptureBody(
  req: VercelRequest,
  res: VercelResponse,
  limit: number,
): Promise<Buffer | null> {
  try {
    return await readRawBodyLimited(req, limit);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.status(413).json({ error: 'upload_too_large', maxUploadBytes: limit });
      return null;
    }
    // The stream died mid-read. A code, not a message: the error text can quote
    // request bytes, and the request is a recording.
    res.status(400).json({ error: 'invalid_body' });
    return null;
  }
}

/**
 * The default slide label.
 *
 * The same string capture-service substitutes for a blank slideTitle
 * (capture_service/schemas.py DEFAULT_SLIDE_TITLE), so a meeting labelled by the
 * browser and one labelled by the service read the same to the model.
 */
export const DEFAULT_SLIDE_TITLE = 'Full meeting recording';

/** A non-negative integer, or null. Rejects NaN, Infinity and negatives. */
function toUint(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * The spatial context, or null when it is not a usable one.
 *
 * agendaIdx defaults to 0 and a blank slideTitle to DEFAULT_SLIDE_TITLE, exactly
 * as the browser's own meetingSlideContext does: a missing label is not a reason
 * to refuse a meeting, and an empty string in the prompt is worse than a generic
 * one because the model then has nothing to anchor the review to.
 */
export function parseSlideContext(raw: unknown): SlideContext | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const agendaIdx = record.agendaIdx === undefined ? 0 : toUint(record.agendaIdx);
  if (agendaIdx === null) return null;

  const slideTitle = trimmedString(record.slideTitle) || DEFAULT_SLIDE_TITLE;

  const context: SlideContext = { agendaIdx, slideTitle };
  const hovered = trimmedString(record.hoveredPartName);
  if (hovered) context.hoveredPartName = hovered;
  const laser = trimmedString(record.laserTargetPartName);
  if (laser) context.laserTargetPartName = laser;
  return context;
}

/**
 * One transcript chunk, or null.
 *
 * A blank `text` carries nothing and a blank `speakerId` carries nothing to
 * attribute it to: the extraction prompt renders each chunk as
 * `c0 [00:00-00:04] <speakerId>: <text>`, so a blank speaker produces a line that
 * asks the model to attribute an insight to nobody, and the card it gets back has
 * an `agentId` the tracker cannot resolve to a participant. Both are refused here
 * rather than passed on.
 */
export function parseTranscriptChunk(raw: unknown): TranscriptChunk | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const speakerId = trimmedString(record.speakerId);
  const text = trimmedString(record.text);
  const startMs = toUint(record.startMs);
  const endMs = toUint(record.endMs);
  if (
    speakerId === null || speakerId === '' ||
    text === null || text === '' ||
    startMs === null || endMs === null
  ) {
    return null;
  }
  return { speakerId, text, startMs, endMs };
}

/**
 * The three-state result every optional-field parser here returns.
 *
 *   undefined — the client did not send it, which is fine;
 *   null      — the client sent something that is not the shape, which is NOT
 *               fine: a silently dropped component list is how a model starts
 *               inventing component ids, so the whole request is refused;
 *   T         — present and usable.
 *
 * A convention rather than a tagged union because this project compiles without
 * `strict`, and narrowing a generic discriminated union there needs a cast — the
 * last thing a validator of untrusted input should be doing.
 */
export type OptionalField<T> = T | null | undefined;

/**
 * Read one field, accepting either spelling.
 *
 * The JSON endpoints send these as real arrays; the multipart path sends them as
 * JSON-encoded form fields, because a form field can only be a string. Both
 * arrive here, and both are validated identically.
 */
function readJsonField(source: Record<string, unknown>, name: string): unknown {
  const raw = source[name];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A string that is not JSON is the client's mistake, not an absent field.
      return null;
    }
  }
  return raw;
}

/**
 * A non-empty array of objects, or null.
 *
 * An EMPTY list is returned as an empty array rather than treated as absent:
 * "no components" is a real state (a room with no model loaded), and the prompt
 * already handles it by omitting the section entirely.
 */
function arrayOfObjects(value: unknown): OptionalField<Array<Record<string, unknown>>> {
  if (value === undefined) return undefined;
  if (value === null || !Array.isArray(value)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    out.push(entry as Record<string, unknown>);
  }
  return out;
}

function parseComponentTree(value: unknown): OptionalField<ComponentTreeEntry[]> {
  const entries = arrayOfObjects(value);
  if (entries === undefined) return undefined;
  if (entries === null) return null;
  const out: ComponentTreeEntry[] = [];
  for (const entry of entries) {
    const id = trimmedString(entry.id);
    const name = trimmedString(entry.name);
    const path = trimmedString(entry.path);
    // All three are required: a component without an id cannot be referenced by a
    // card, and one without a path is invisible in the tree the reviewer sees.
    if (id === null || id === '' || name === null || path === null) return null;
    out.push({ id, name, path });
  }
  return out;
}

function parsePointingSegments(value: unknown): OptionalField<PointingSegmentWire[]> {
  const entries = arrayOfObjects(value);
  if (entries === undefined) return undefined;
  if (entries === null) return null;
  const out: PointingSegmentWire[] = [];
  for (const entry of entries) {
    const userId = trimmedString(entry.userId);
    const userName = trimmedString(entry.userName);
    const partId = trimmedString(entry.partId);
    const partName = trimmedString(entry.partName);
    const fromMs = toUint(entry.fromMs);
    const toMs = toUint(entry.toMs);
    if (
      userId === null || userName === null || partId === null || partName === null ||
      fromMs === null || toMs === null
    ) {
      return null;
    }
    out.push({ userId, userName, partId, partName, fromMs, toMs });
  }
  return out;
}

function parseTranscriptHint(value: unknown): OptionalField<TranscriptHintLine[]> {
  const entries = arrayOfObjects(value);
  if (entries === undefined) return undefined;
  if (entries === null) return null;
  const out: TranscriptHintLine[] = [];
  for (const entry of entries) {
    const speaker = trimmedString(entry.speaker);
    const text = trimmedString(entry.text);
    const offsetMs = toUint(entry.offsetMs);
    if (speaker === null || text === null || text === '' || offsetMs === null) return null;
    out.push({ speaker, text, offsetMs });
  }
  return out;
}

/**
 * Caps on the three grounded-capture lists.
 *
 * The same three numbers capture-service applies
 * (capture_service/main.py `_MAX_COMPONENTS`, `_MAX_POINTING_SEGMENTS`,
 * `_MAX_TRANSCRIPT_HINT_LINES`), and applied the same way — TRUNCATE, not refuse.
 * Two reasons they have to agree:
 *
 *   * a deployment that switches the cards job from the built-in stack to a cloud
 *     provider must not suddenly start sending a 10 000-entry component list,
 *     because until then capture-service was quietly cutting it to 200;
 *   * truncating rather than refusing is the right answer for a list that is a
 *     PROMPT SECTION. A review with 900 parts still deserves its cards extracted
 *     from the first 200 of them; a review that gets a 400 because its model was
 *     large gets nothing.
 */
const MAX_COMPONENTS = 200;
const MAX_POINTING_SEGMENTS = 500;
const MAX_TRANSCRIPT_HINT_LINES = 400;

/**
 * The grounded-capture context: the component list, the pointing timeline and the
 * live speaker-labelled transcript.
 *
 * Follows the OptionalField convention: undefined when the client sent none of
 * the three (the pre-grounded-capture shape, still perfectly valid), null when any
 * one of them is malformed.
 */
export function parseGrounded(raw: unknown): OptionalField<GroundedCaptureContext> {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const componentTree = parseComponentTree(readJsonField(source, 'componentTree'));
  if (componentTree === null) return null;
  const pointingSegments = parsePointingSegments(readJsonField(source, 'pointingSegments'));
  if (pointingSegments === null) return null;
  const transcriptHint = parseTranscriptHint(readJsonField(source, 'transcriptHint'));
  if (transcriptHint === null) return null;

  const grounded: GroundedCaptureContext = {};
  if (componentTree !== undefined) grounded.componentTree = componentTree.slice(0, MAX_COMPONENTS);
  if (pointingSegments !== undefined) {
    grounded.pointingSegments = pointingSegments.slice(0, MAX_POINTING_SEGMENTS);
  }
  if (transcriptHint !== undefined) {
    grounded.transcriptHint = transcriptHint.slice(0, MAX_TRANSCRIPT_HINT_LINES);
  }
  return Object.keys(grounded).length === 0 ? undefined : grounded;
}

/**
 * Read the grounded fields straight off a parsed multipart form.
 *
 * Same validation as parseGrounded, with FormData's string spelling resolved
 * first. A field that is absent from the form is left absent rather than passed
 * through as null, so "not sent" and "sent broken" stay distinguishable.
 */
export function parseGroundedFromForm(form: FormData): OptionalField<GroundedCaptureContext> {
  const source: Record<string, unknown> = {};
  for (const name of ['componentTree', 'pointingSegments', 'transcriptHint']) {
    const value = form.get(name);
    if (typeof value === 'string') source[name] = value;
  }
  return parseGrounded(Object.keys(source).length === 0 ? undefined : source);
}

/**
 * Parse a raw multipart body.
 *
 * Uses the runtime's own WHATWG parser rather than a hand-rolled boundary scan:
 * the body is up to 200 MB of someone's meeting, and a parser we wrote is a
 * parser we have to defend. Returns null when the content type is not multipart or
 * the body cannot be read as one.
 */
export async function parseMultipart(
  raw: Buffer,
  contentType: string | string[] | undefined,
): Promise<FormData | null> {
  // Node gives a repeated header as an array. Taking the first is what every
  // other layer here does, and a request with two Content-Types is not one this
  // endpoint can honour either way.
  const type = Array.isArray(contentType) ? (contentType[0] ?? '') : (contentType ?? '');
  if (!type.toLowerCase().startsWith('multipart/form-data')) return null;
  try {
    // A Request is the only WHATWG entry point that will parse multipart for us.
    // The URL is never fetched; it exists because the constructor requires one.
    const request = new Request('http://localhost/api/capture', {
      method: 'POST',
      headers: { 'content-type': type },
      body: new Uint8Array(raw),
    });
    return await request.formData();
  } catch {
    return null;
  }
}

/** The audio part of a form, as a Blob the router can forward. */
export function audioFromForm(form: FormData, fieldName = 'audio'): Blob | null {
  const part = form.get(fieldName);
  if (typeof part === 'string' || part === null) return null;
  return part as unknown as Blob;
}

/**
 * Turn a router failure into a response.
 *
 * This is the whole of the "no leak" contract on the response side, in one place:
 * the body is a code from our own vocabulary, an optional parser `reason` enum,
 * and at most a couple of numbers the router explicitly marked as safe. The
 * upstream's status, prose and body are gone by the time anything reaches here.
 *
 * A caller hang-up is logged by CODE ONLY. The router reports it as an
 * AiJobError, but an abort that surfaces as some other error type carries a stack
 * that can quote the request — and the request is a recording.
 */
export function sendJobError(res: VercelResponse, err: unknown, where: string): void {
  const jobError = asAiJobError(err);
  const body: Record<string, unknown> = { error: jobError.code };
  if (jobError.reason) body.reason = jobError.reason;
  for (const [name, value] of Object.entries(jobError.extras)) body[name] = value;

  if (jobError.code === 'request_closed') {
    console.error(`[capture] ${where}: the client disconnected`);
  } else {
    // The message is ours: provider, code and a short note this repo wrote. It
    // never contains a transcript, a key or upstream prose.
    console.error(`[capture] ${where} failed:`, jobError.message);
  }
  res.status(jobError.status).json(body);
}

/** True when a router/endpoint failure was the caller hanging up. */
export function isClientGone(err: unknown): boolean {
  return asAiJobError(err).code === 'request_closed';
}
