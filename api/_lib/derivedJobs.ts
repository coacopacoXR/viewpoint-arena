// Conversion jobs: the state that turns an upload into a derivative.
//
// POST /api/models stores a CAD file and then starts a conversion WITHOUT
// waiting for it, because a 200 MB assembly takes minutes to tessellate and the
// person importing it is owed an answer now. That leaves the api needing to
// remember, for as long as the conversion runs, that it is running — which is
// what this module is: one Map, sourceHash → job.
//
// The state is deliberately IN MEMORY and deliberately not durable:
//
//   * a derivative is a cache. Losing track of a job costs a re-conversion, not
//     data, and the source file is stored and safe whatever happens here;
//   * the recovery path is the same code as the first attempt — a status request
//     for a hash with no derivative and no job starts a job — so an api restart
//     mid-conversion, or a second replica that never saw the upload, heals on the
//     next poll rather than needing a queue, a table or a lock;
//   * nothing a browser holds depends on it. The room socket and a curated review
//     carry the SOURCE hash, which is why a derivative is never addressed by its
//     own (see DerivedKind in lib/storage/modelStore.ts).
//
// What is NOT here, on purpose: retries (a failed conversion is reported and
// stays failed until something asks again), a queue (convert-service has one —
// CONVERT_CONCURRENCY, extra requests wait there rather than here), and any
// persistence across a restart.

import type { ModelStore } from '../../lib/storage/modelStore.ts';
import { isModelHash } from '../../lib/storage/modelStore.ts';
import { CAD_EXTENSIONS, modelFileExtension } from '../../utils/modelFormats.ts';
import {
  CONVERT_ERROR,
  ConvertFailure,
  convertToGlb,
  resolveConvertTarget,
  type ConvertOptions,
  type ConvertTarget,
} from './convertClient.ts';

/** The one derivative this module produces. */
const DERIVED_KIND = 'glb' as const;

/** A job this process started. `done` is not a state: see finish(). */
type JobState = 'pending' | 'failed';

interface Job {
  state: JobState;
  /** Set when state is 'failed': a code, never a message. */
  reason?: string;
}

/**
 * The jobs this process knows about, keyed by source hash.
 *
 * Module-level because it has to be process-level: two requests for the same file
 * have to find each other's job, and the api container is one process
 * (server/api-server.ts). On Vercel there is no such thing as a shared Map, which
 * is one more reason CONVERT_SERVICE_URL is unset there and none of this runs.
 */
const jobs = new Map<string, Job>();

/**
 * How many jobs are tracked before the oldest are dropped.
 *
 * A finished conversion removes its own entry, so what accumulates is failures —
 * one per source hash this process tried and could not complete. Each is a hash
 * and a short code, but an api container that runs for months beside a
 * convert-service that is down would otherwise grow without limit. Dropping the
 * oldest is safe because the only thing an entry buys is a reason to report
 * instead of starting again: an evicted failure just gets retried on the next
 * request, which is what a stale failure deserves anyway.
 */
const MAX_TRACKED_JOBS = 512;

/** Reasons this module adds to convert-service's own vocabulary. */
const SOURCE_GONE = 'source_not_found';
const STORAGE_FAILED = 'storage_error';

/** What an upload response says about the derivative it just set going. */
export type DerivedAvailability = 'pending' | 'unavailable';

/** What the derived route answers with, before it decides on a status code. */
export type DerivedStatus =
  | { status: 'ready'; size: number }
  | { status: 'pending' }
  | { status: 'failed'; reason: string }
  | { status: 'unavailable' }
  | { status: 'not_found' };

/**
 * Start converting a stored CAD file, and return immediately.
 *
 * The answer is what the caller should say about the derivative, and 'unavailable'
 * covers every reason there will never be one: no convert-service configured (the
 * default, and the whole of a Vercel deployment's experience), a source that is
 * not a format the service reads, and a hash that is not a hash. All three are
 * configurations of the deployment or of the file rather than failures, so none of
 * them is logged as one.
 *
 * `bytes` is the upload the caller is already holding. Passing it saves a full
 * re-read of the stored object — a disk stream on the local provider, and a
 * bucket download on the hosted one — and costs nothing new: the api buffered
 * those bytes to hash them in the first place (api/_lib/rawBody.ts), so this only
 * decides how long they are held for.
 */
export function startDerivedGlb(
  store: ModelStore,
  sourceHash: string,
  fileName: string,
  options: ConvertOptions & { bytes?: Uint8Array } = {},
): DerivedAvailability {
  if (!isModelHash(sourceHash)) return 'unavailable';
  if (!isCadFile(fileName)) return 'unavailable';
  const target = resolveConvertTarget(options.env);
  if (!target) return 'unavailable';

  // Dedup. A second upload of the same file while a conversion is running joins
  // it rather than queueing behind it: convert-service runs CONVERT_CONCURRENCY
  // jobs at a time (one, by default), so a duplicate would be a second full
  // tessellation of identical bytes and a queue twice as deep for everybody else.
  //
  // A FAILED job is replaced rather than joined. The upload is a fresh intent, and
  // a hash that failed once because convert-service was restarting must not stay
  // failed for the life of the process.
  if (jobs.get(sourceHash)?.state === 'pending') return 'pending';

  const job: Job = { state: 'pending' };
  // Registered BEFORE the work starts, so a status request that arrives while the
  // first bytes are still being read finds a pending job rather than starting a
  // second conversion of the same file.
  jobs.set(sourceHash, job);
  trimJobs();
  // Detached, and safe to detach: runJob catches everything, so there is no
  // rejection left unhandled and no caller waiting on the promise.
  void runJob(job, store, sourceHash, fileName, target, options);
  return 'pending';
}

/**
 * The state of a source file's derivative, starting a conversion when the store
 * has none and this process knows of no reason there should not be one.
 *
 * This is the route's whole decision, in one place: the answer is ready, pending,
 * failed with a reason, unavailable, or not_found for a source nobody stored. The
 * recovery branch is what an api restart mid-conversion lands in — the job is
 * gone with the process, the derivative never arrived, and the next participant to
 * ask is the one who sets it going again.
 */
export async function derivedGlbStatus(
  store: ModelStore,
  sourceHash: string,
  options: ConvertOptions = {},
): Promise<DerivedStatus> {
  if (!isModelHash(sourceHash)) return { status: 'not_found' };

  const existing = await store.headDerived(sourceHash, DERIVED_KIND);
  if (existing) return { status: 'ready', size: existing.size };

  const job = jobs.get(sourceHash);
  if (job) {
    return job.state === 'pending'
      ? { status: 'pending' }
      : { status: 'failed', reason: job.reason ?? CONVERT_ERROR };
  }

  // No derivative and no job. Reading the source's sidecar is what decides
  // between "not stored", "not a CAD file" and "worth converting", and it is one
  // metadata read on a path that is already rare.
  const meta = await store.head(sourceHash);
  if (!meta) return { status: 'not_found' };
  return startDerivedGlb(store, sourceHash, meta.fileName, options) === 'pending'
    ? { status: 'pending' }
    : { status: 'unavailable' };
}

/** Whether this is a format convert-service reads, from the name's extension. */
export function isCadFile(fileName: string): boolean {
  return CAD_EXTENSIONS.includes(modelFileExtension(fileName));
}

/**
 * One conversion, start to stored derivative. Never throws: the caller has
 * already answered its request, so there is nobody left to tell, and an unhandled
 * rejection here would take the api process down for a failed tessellation.
 */
async function runJob(
  job: Job,
  store: ModelStore,
  sourceHash: string,
  fileName: string,
  target: ConvertTarget,
  options: ConvertOptions & { bytes?: Uint8Array },
): Promise<void> {
  try {
    const bytes = options.bytes ?? (await readSource(store, sourceHash));
    if (!bytes) throw new ConvertFailure(SOURCE_GONE, 'the source file is no longer stored');

    const converted = await convertToGlb(target, bytes, fileName, options);
    try {
      await store.putDerived(sourceHash, DERIVED_KIND, converted.body);
    } catch (err) {
      // The conversion worked and the store did not, which is a different fix
      // from a tessellation failure and reads as one in the log below.
      console.error(`[convert] could not store the derivative for ${sourceHash}:`, err);
      throw new ConvertFailure(STORAGE_FAILED, 'the converted GLB could not be stored');
    }

    // Counts and timings, never content: no filename, no path, no part name. The
    // hash is already public in every URL that serves this model.
    console.info(
      `[convert] ${sourceHash}: ${converted.partCount ?? '?'} part(s), ` +
        `${converted.triangleCount ?? '?'} triangle(s), ${converted.convertMs ?? '?'} ms`,
    );
    finish(sourceHash, job);
  } catch (err) {
    // Mutated in place, so the entry the map holds is the one that reports the
    // failure — and it STAYS in the map, because its reason is what the next
    // status request for this hash answers with. A re-upload is what clears it.
    job.state = 'failed';
    job.reason = err instanceof ConvertFailure ? err.reason : CONVERT_ERROR;
    // The message is this module's own or a ConvertFailure's, both content-free;
    // an unexpected throw is described by type rather than printed, because that
    // is the one message here this repo did not write.
    console.error(
      `[convert] ${sourceHash} failed (${job.reason}):`,
      err instanceof ConvertFailure ? err.message : typeName(err),
    );
  }
}

/**
 * Forget a job that succeeded.
 *
 * 'done' is not a state in the map, and that is the point: the store holds the
 * derivative and is the only authority on whether one exists. A 'done' entry
 * would be a second place to be wrong — the admin console deletes a model, the
 * entry says done, and the route answers 200 for a GLB that is no longer there.
 */
function finish(sourceHash: string, job: Job): void {
  // Identity-checked: a re-upload during this conversion replaced the entry with
  // a newer job, and deleting by key would forget the one still running.
  if (jobs.get(sourceHash) === job) jobs.delete(sourceHash);
}

/** The stored source as bytes, or null when the store no longer has it. */
async function readSource(store: ModelStore, sourceHash: string): Promise<Uint8Array | null> {
  const stream = await store.get(sourceHash);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Drop the oldest entries once the map is over its bound. */
function trimJobs(): void {
  while (jobs.size > MAX_TRACKED_JOBS) {
    // Map iteration order is insertion order, so the first key is the oldest.
    const oldest = jobs.keys().next();
    if (oldest.done) return;
    jobs.delete(oldest.value);
  }
}

/** An unexpected error's type. Its message is the one thing here we did not write. */
function typeName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
