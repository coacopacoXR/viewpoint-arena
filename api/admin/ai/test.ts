import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../_lib/adminAuth.ts';
import {
  AI_JOBS,
  aiSettingKey,
  isAiProviderId,
  modelForJob,
  type AiJob,
} from '../../../lib/ai/providers.ts';
import { openSettingSecret } from '../../../lib/ai/settingsStore.ts';
import {
  asAiJobError,
  runJob,
  silentWav,
  TEST_SLIDE_CONTEXT,
  TEST_SUMMARY_TITLE,
  TEST_TRANSCRIPT,
  validateSubmittedSetting,
  type AiJobInput,
  type ResolvedJob,
} from '../../../lib/ai/router.ts';

/**
 * POST /api/admin/ai/test — "Test connection", against values not yet saved.
 *
 * The point of this endpoint is that an administrator can find out whether a key
 * and a model name work BEFORE a meeting depends on them, and can try a second
 * model without overwriting the setting that is currently serving the room. So it
 * runs a real, tiny request through the real router with the submitted values and
 * reports either the elapsed time or the plain reason it failed.
 *
 * What each job sends:
 *   transcription — a one-second silent WAV generated in code (silentWav), which
 *                   is the smallest thing every ASR stack accepts as a recording;
 *   cards         — a two-line transcript about a bracket weld, which a working
 *                   provider answers with zero or more cards. Zero is a pass: the
 *                   contract is "it understood the request", not "it found a risk".
 *   summary       — the same two lines, asking for markdown minutes.
 *
 * ── WHAT THE RESPONSE MAY SAY ────────────────────────────────────────────────
 * `reason` is an AiJobError's message: a provider name, a code from the router's
 * closed vocabulary, and a note this repo wrote itself (a URL PATH, a status
 * number). It never contains the key, the transcript, an upstream body or a model
 * answer — those are the four things the capture endpoints' security header
 * forbids, and a diagnostic endpoint an admin can trigger on demand is exactly
 * where a leak like that would be found. An unexpected throw is funnelled through
 * asAiJobError, which logs the detail and returns a generic message, because a
 * bug's stack is the one string here that might quote the request.
 */

/**
 * The ceiling on a test call.
 *
 * Thirty seconds is long enough for a cloud round trip and for a warm 7B model,
 * and short enough that an admin pressing the button gets an answer instead of a
 * spinner. A built-in stack that is still cold-loading a model will time out here
 * and succeed in production, and the reason it reports says so.
 */
const TEST_TIMEOUT_MS = 30_000;

interface TestRequestBody {
  job?: unknown;
  provider?: unknown;
  fields?: unknown;
  /** The credential to test with. Omitted means "the one already stored". */
  secret?: unknown;
}

/**
 * The first sentence an administrator reads when a test fails, in plain words,
 * with what to check. The router's own message (provider, code, a path or a
 * status this repo wrote) follows it as "Details:", for whoever debugs — it was
 * the whole answer before, and "ai/openaiCompatible: capture_upstream_unreachable
 * (/v1/chat/completions)" told an admin nothing they could act on.
 */
export function plainTestFailure(code: string, detail: string): string {
  const sentence = (() => {
    switch (code) {
      case 'capture_upstream_unreachable':
        return 'This server could not reach that address. Check the URL, and that this server is allowed to reach it (firewall, proxy, or a Docker network it is not on).';
      case 'capture_upstream_timeout':
        return 'The service did not answer within 30 seconds. It may be starting up or overloaded; try again, or check it is running.';
      case 'capture_upstream_error':
        return 'The service answered with an error. Check the key, the model or deployment name, and that your account can use that model.';
      case 'capture_endpoint_unavailable':
        return 'Something answered at that address, but not the API expected. Check the URL points at the API itself (for OpenAI-compatible servers it usually ends in /v1).';
      case 'capture_output_truncated':
        return 'The model stopped before finishing its answer. Pick a model with a larger output limit.';
      case 'capture_parse_error':
        return 'The service answered, but not in the expected shape. For your own service, check it follows the documented format.';
      case 'capture_not_configured':
        return 'This provider is missing something it needs, usually the key.';
      case 'empty_transcript':
        return 'The service answered but heard no speech. That is expected for the silent test clip only if the service rejects silence; try a real recording.';
      default:
        return 'The connection test did not succeed.';
    }
  })();
  return `${sentence} Details: ${detail}`;
}

function isAiJob(value: unknown): value is AiJob {
  return typeof value === 'string' && (AI_JOBS as readonly string[]).includes(value);
}

function testInputFor(job: AiJob): AiJobInput {
  switch (job) {
    case 'transcription':
      return { audio: silentWav(), filename: 'connection-test.wav', contentType: 'audio/wav' };
    case 'cards':
      return { transcript: TEST_TRANSCRIPT, context: TEST_SLIDE_CONTEXT };
    case 'summary':
      return { transcript: TEST_TRANSCRIPT, cards: [], title: TEST_SUMMARY_TITLE };
  }
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as TestRequestBody;
  if (!isAiJob(body.job)) {
    res.status(400).json({ error: 'invalid_body', fields: ['job'] });
    return;
  }
  const job = body.job;

  if (!isAiProviderId(body.provider)) {
    res.status(400).json({ error: 'invalid_provider' });
    return;
  }
  const setting = validateSubmittedSetting(job, {
    provider: body.provider,
    fields: body.fields,
  });
  if (setting === null) {
    res.status(400).json({ error: 'invalid_body', fields: ['provider', 'fields'] });
    return;
  }

  // A submitted key wins; otherwise test with the stored one, so an admin can
  // re-test a saved provider without re-pasting a credential they can no longer
  // see. `secret: null` means "test with no credential", which is a legitimate
  // thing to want for an openai-compatible server on the LAN.
  const secret =
    typeof body.secret === 'string' && body.secret.trim() !== ''
      ? body.secret.trim()
      : body.secret === null
        ? null
        : await openSettingSecret(aiSettingKey(job));

  const resolved: ResolvedJob = {
    job,
    provider: setting.provider,
    // Reported as 'settings' because that is what these values would become. The
    // distinction matters in the router's resolution order, not in the answer.
    source: 'settings',
    fields: setting.fields,
    secret,
    // modelForJob, not fields.model: a provider's default for THIS job is what a
    // blank model box means, and Azure has no model field at all (its deployment
    // name is the model), so reading the field directly would send nothing.
    model: modelForJob(job, setting),
  };

  const startedAt = Date.now();
  try {
    await runJob(job, testInputFor(job), { resolved, timeoutMs: TEST_TIMEOUT_MS });
    res.status(200).json({ ok: true, job, ms: Date.now() - startedAt });
  } catch (err) {
    const failure = asAiJobError(err, setting.provider);
    // Logged in full server-side, where the detail belongs; answered with the
    // code and the note.
    console.error(`[admin/ai/test] ${job} via ${setting.provider} failed:`, failure.message);
    res.status(200).json({
      // 200, not the failure's own status: the REQUEST succeeded, and the thing it
      // was asked to find out is that the provider does not work. Answering 502
      // here would make the screen show "the admin console is down".
      ok: false,
      job,
      ms: Date.now() - startedAt,
      code: failure.code,
      reason: plainTestFailure(failure.code, failure.message),
    });
  }
}

export default handler;
