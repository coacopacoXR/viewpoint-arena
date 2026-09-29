// POST /api/capture/transcribe — one audio slice in, transcript out.
//
// The live-transcript path (T4.7): the browser records N-second chunks from each
// participant's own mic and posts each one here. Same contract as before this
// batch — multipart `audio` in, `{ transcript }` out, same error codes, same
// 10 MB ceiling — with one change: the AI that does the work is chosen by
// lib/ai/router.ts rather than by nginx routing the request straight to
// capture-service.
//
// That change is the reason this file exists as a handler at all instead of being
// a proxy_pass line. A deployment can now transcribe with its own Whisper while
// extracting cards with OpenAI, or send both to a company gateway, without the
// browser knowing or caring. deploy/nginx/app.conf still fronts this path with the
// access subrequest and the body limit; it just no longer bypasses the api.
//
// SECURITY: identical to the other capture endpoints. The audio is the meeting and
// the transcript is what people said in it, so a failure is reported as a code from
// the router's closed vocabulary — never as a stack, an upstream body or a message
// that could quote either. The shared secret capture-service wants is added by the
// router from THIS container's environment and never reaches the browser.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runJob } from '../../lib/ai/router.ts';
import { recordingFilename } from '../../lib/connectors/capture/local.ts';
import {
  audioFromForm,
  enforceCaptureAccess,
  parseMultipart,
  readCaptureBody,
  sendJobError,
} from './_request.ts';

/** A chunk is seconds of audio; a full meeting goes to /api/capture/local. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const config = { api: { bodyParser: false } };

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Front-door password, when the deployment has one. Same gate as every other
  // capture endpoint — this one accepts audio, so it gets the same treatment as
  // the one that accepts a whole recording.
  if (!enforceCaptureAccess(req, res)) return;

  const raw = await readCaptureBody(req, res, MAX_UPLOAD_BYTES);
  if (raw === null) return;

  const form = await parseMultipart(raw, req.headers['content-type']);
  const audio = form === null ? null : audioFromForm(form);
  if (form === null || audio === null || audio.size === 0) {
    // One answer for "not multipart", "no audio part" and "an empty audio part":
    // distinguishing them would mean describing what arrived.
    res.status(400).json({ error: 'empty_upload' });
    return;
  }

  try {
    const result = await runJob('transcription', {
      audio,
      // The browser's own MIME-type → extension mapping, shared with
      // api/capture/local.ts so the two audio paths cannot disagree about what a
      // recording is called.
      filename: recordingFilename(audio.type),
      contentType: audio.type || 'audio/webm',
      signal: requestSignal(req),
    });
    if (result.job !== 'transcription') {
      res.status(502).json({ error: 'capture_upstream_error' });
      return;
    }
    // The wire shape the browser already validates: camelCase chunks, no envelope
    // metadata. A live-transcript line that arrives with a `took 4.2s` key on it is
    // a rejected response, not a cosmetic difference.
    res.status(200).json({ transcript: result.transcript });
  } catch (err) {
    sendJobError(res, err, 'transcribe');
  }
}

function requestSignal(req: VercelRequest): AbortSignal | undefined {
  const candidate = (req as unknown as { signal?: unknown }).signal;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

export default handler;
