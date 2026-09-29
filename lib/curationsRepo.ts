// Supabase-backed persistence for review curations. The whole ReviewDraft
// shape is stored as jsonb columns in the `review_curations` table; the row
// id IS the reviewId, which IS the roomId — so /review/:id/setup and
// /room/:id refer to the same curation across browsers and devices.
//
// The MODEL is not in the row. `asset.modelHash` is the SHA-256 of a file that
// lives in model storage (POST /api/models), and `asset.importedFileName` is the
// name it was imported under, which is what the loaders dispatch on. Together
// they are a few dozen bytes and they outlive the browser that uploaded them,
// which is what lets a review be opened on a phone that has never seen the file.
//
// `importedFileBase64` is the shape this had BEFORE that: the file itself,
// base64-encoded, in the jsonb column. It is stripped on every write below, and
// a row that still carries one is migrated on load — see migrateCurationAsset.

import { supabase, supabaseConfigured } from './supabase';
import { migrateCurationAsset } from './migrateCurationAsset';
import { ensureReviewOwner } from './reviews/membersRepo';
import { deleteReview as deleteReviewRequest } from './reviews/deleteClient';
import { createReviewDraft, NEW_REVIEW_TITLE, reviewTitleFrom } from './reviewSetupStore';
import type { ReviewDraft } from './reviewSetupStore';

export interface CurationSummary {
  id: string;
  title: string;
  description: string;
  viewpoint_count: number;
  pin_count: number;
  slide_count: number;
  listed: boolean;
  updated_at: string;
  created_at: string;
  /**
   * A small JPEG data URL of the review's model, captured in the room
   * (lib/reviews/thumbnail.ts, batch BO). Optional because only the summary read asks
   * for the column: the list reads that predate it answer undefined, and a database
   * that has never had it applied answers null rather than failing the whole read.
   */
  thumbnail?: string | null;
}

interface CurationRow {
  id: string;
  title: string;
  description: string;
  asset: ReviewDraft['asset'];
  viewpoints: ReviewDraft['viewpoints'];
  pins: ReviewDraft['pins'];
  agenda: ReviewDraft['agenda'];
  requirements?: ReviewDraft['requirements'];
  team?: ReviewDraft['team'];
  labels?: ReviewDraft['labels'];
  listed?: boolean;
  created_at: string;
  updated_at: string;
}

function rowToDraft(row: CurationRow): ReviewDraft {
  return {
    reviewId: row.id,
    title: row.title,
    description: row.description,
    asset: row.asset,
    viewpoints: row.viewpoints ?? [],
    pins: row.pins ?? [],
    agenda: row.agenda ?? [],
    requirements: row.requirements ?? [],
    team: row.team ?? [],
    labels: row.labels ?? {},
    listed: row.listed ?? true,
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.updated_at),
  };
}

function draftToRow(draft: ReviewDraft) {
  // The inline blob never reaches the database, even from a draft that has not
  // been migrated yet: the file it names belongs in model storage, and a row
  // that carried it would be tens of megabytes of jsonb read back by every
  // browser that opens the review. `modelHash` and `importedFileName` are kept,
  // and they are what a migrated draft has instead.
  const { importedFileBase64: _stripped, ...assetSansBlob } = draft.asset;
  return {
    id: draft.reviewId,
    title: draft.title,
    description: draft.description,
    asset: assetSansBlob,
    viewpoints: draft.viewpoints,
    pins: draft.pins,
    agenda: draft.agenda,
    requirements: draft.requirements,
    team: draft.team,
    labels: draft.labels,
    listed: draft.listed,
  };
}

export async function loadCuration(id: string): Promise<ReviewDraft | null> {
  const { data, error } = await supabase
    .from('review_curations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[curationsRepo] loadCuration failed:', error);
    return null;
  }
  return data ? migrateOnLoad(id, rowToDraft(data as CurationRow)) : null;
}

/**
 * A loaded curation with its model in storage rather than inline.
 *
 * A row written since the migration has `asset.modelHash` and there is nothing
 * to do — migrateCurationAsset answers immediately, so this costs one property
 * test on every load. A row that still carries the base64 blob is uploaded once
 * and the row is rewritten with the hash and without the blob, so the next load
 * takes the fast path and the database stops holding the file.
 *
 * A failed upload leaves the draft exactly as it was loaded: the review still
 * opens with its model on screen, from the inline copy, and the next load tries
 * again. Failing to migrate is not a reason to refuse somebody their review.
 */
async function migrateOnLoad(id: string, draft: ReviewDraft): Promise<ReviewDraft> {
  const result = await migrateCurationAsset(draft.asset);
  if (!result.migrated) {
    if (result.error) {
      console.warn('[curationsRepo] model migration deferred:', result.error);
    }
    return draft;
  }

  // Stripped again on the way out, so no path through this function can write a
  // blob into the column it exists to keep out of.
  const { importedFileBase64: _never, ...assetToSave } = result.asset;
  const { error } = await supabase
    .from('review_curations')
    .update({ asset: assetToSave })
    .eq('id', id);
  if (error) {
    // This browser has the migrated asset in hand, so it is fine; the row is
    // simply migrated again by whoever loads it next. Worth a line, not a
    // failure — the alternative is refusing to open the review.
    console.error('[curationsRepo] could not write the migrated asset back:', error);
  }
  return { ...draft, asset: result.asset };
}

export async function saveCuration(draft: ReviewDraft): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('review_curations')
    .upsert(draftToRow(draft), { onConflict: 'id' });
  if (error) {
    console.error('[curationsRepo] saveCuration failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Bring a design review into existence.
 *
 * Batch BH moved the birth of a review out of the curate page: the lobby's "New
 * design review" writes the row and then opens the ROOM with Edit on, because
 * there is no separate curation screen to prepare it in any more. The row has to
 * exist first — RoomPage seeds the room from loadCuration, and a room with no row
 * opens with nothing to edit.
 *
 * The owner is claimed in the same breath, and only for a browser this
 * deployment signed in: ensureReviewOwner does nothing at all for a guest or for
 * an install on identity.mode 'none', which leaves the review ownerless exactly
 * as every review created before accounts existed is. An admin can claim one
 * later from the People tab.
 *
 * @returns the draft that was written, or null when the row could not be saved.
 *          A review that could not be written is a room that would open empty,
 *          so the lobby says so and stays put rather than navigating.
 */
export async function createReview(
  reviewId: string,
  title: string = NEW_REVIEW_TITLE,
): Promise<ReviewDraft | null> {
  // Normalised here rather than at each caller so "a name nobody typed creates the
  // untitled review" is one rule and not three: the lobby's inline field, the Edit
  // panel's create-if-absent and a PLM launch all reach this function.
  const draft = createReviewDraft(reviewId, reviewTitleFrom(title, NEW_REVIEW_TITLE));
  const saved = await saveCuration(draft);
  if (!saved.ok) return null;
  // Not awaited into the result: a review whose owner row failed to write is
  // still a review, and the person standing in it can still edit it this
  // session. ensureReviewOwner logs why it could not.
  void ensureReviewOwner(reviewId);
  return draft;
}

// The shape the three read paths share. Written out rather than inferred,
// because each one asks for a slightly different column list (and a second,
// pre-`listed` list on an older database), so supabase-js infers a different
// row type per call. `listed` is optional for exactly that reason.
interface CurationListRow {
  id: string;
  title: string;
  description: string;
  viewpoints?: unknown[] | null;
  pins?: unknown[] | null;
  agenda?: unknown[] | null;
  listed?: boolean | null;
  thumbnail?: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSummary(r: CurationListRow): CurationSummary {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    viewpoint_count: Array.isArray(r.viewpoints) ? r.viewpoints.length : 0,
    pin_count: Array.isArray(r.pins) ? r.pins.length : 0,
    slide_count: Array.isArray(r.agenda) ? r.agenda.length : 0,
    // A database without the column hides nothing.
    listed: r.listed !== false,
    updated_at: r.updated_at,
    created_at: r.created_at,
    // Null rather than undefined, so a caller can tell "this read asked and there is no
    // snapshot" from "this read never asked" without knowing which columns it named.
    thumbnail: r.thumbnail ?? null,
  };
}

// PostgREST's code for "column does not exist" — an install whose database
// predates a column and has not re-applied docs/supabase-schema.sql yet.
//
// `listed` shipped 2026-09-23, so every read that mentions it needs a way
// back. Mentioning it at all is enough to fail: PostgREST rejects the whole
// request for an unknown column in the SELECT list, not only in a filter. A
// read that gave up here would empty the lobby of every saved review over a
// flag that database has never heard of, so each one asks again with the
// pre-`listed` column list and treats the rows as listed, which they are.
//
// `archived` shipped a day later (batch BE) and needs the same way back, but
// only in the one read that filters on it — and there it needs a step of its
// own, because a database can have `listed` and not `archived`. Dropping both
// filters at once would put every link-only review back in the lobby.
const UNDEFINED_COLUMN = '42703';

// Each pair differs only by `listed`. They are spelled out rather than derived
// from one another because supabase-js reads the row shape out of the literal
// string, and a computed one types the result as an error.
const LIST_COLUMNS =
  'id,title,description,viewpoints,pins,agenda,requirements,team,labels,listed,created_at,updated_at';
const LIST_COLUMNS_LEGACY =
  'id,title,description,viewpoints,pins,agenda,requirements,team,labels,created_at,updated_at';

const ADMIN_COLUMNS =
  'id,title,description,viewpoints,pins,agenda,listed,created_at,updated_at';
const ADMIN_COLUMNS_LEGACY =
  'id,title,description,viewpoints,pins,agenda,created_at,updated_at';

// `thumbnail` (batch BO) is asked for by the summary read alone, so it gets a tier of
// its own between the two above: a database that has `listed` and no `thumbnail` is
// every install upgraded as far as 2026-09-24, and dropping straight to the legacy list
// would lose the `listed` filter for a column that only the lobby's preview uses.
const SUMMARY_COLUMNS =
  'id,title,description,viewpoints,pins,agenda,requirements,team,listed,thumbnail,created_at,updated_at';
const SUMMARY_COLUMNS_NO_THUMBNAIL =
  'id,title,description,viewpoints,pins,agenda,requirements,team,listed,created_at,updated_at';
const SUMMARY_COLUMNS_LEGACY =
  'id,title,description,viewpoints,pins,agenda,requirements,team,created_at,updated_at';

export async function listRecentCurations(limit = 8): Promise<CurationSummary[]> {
  // Only listed reviews appear here, and not the ones an admin has put away.
  // Both are still reachable by their link through loadCuration /
  // getCurationSummary, which is what keeps /room/:id and the invited preview
  // working for a review the lobby no longer offers. Filtering here rather than
  // in the page also means the `limit` counts reviews that will be shown: a
  // filtered-afterwards list of 8 would come back short.
  const first = await supabase
    .from('review_curations')
    .select(LIST_COLUMNS)
    .eq('listed', true)
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(limit);

  // No `archived` column: keep the `listed` filter, which this database does
  // have, and take every listed row — nothing in it can have been archived.
  const second = first.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(LIST_COLUMNS)
        .eq('listed', true)
        .order('updated_at', { ascending: false })
        .limit(limit)
    : first;

  // No `listed` column either: drop both the filters and the column, and take
  // every row — in such a database every review is listed by definition.
  const { data, error } = second.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(LIST_COLUMNS_LEGACY)
        .order('updated_at', { ascending: false })
        .limit(limit)
    : second;

  if (error) {
    console.error('[curationsRepo] listRecentCurations failed:', error);
    return [];
  }
  return ((data ?? []) as unknown as CurationListRow[]).map(rowToSummary);
}

// Every review on this install, including link-only and archived ones — used
// by the admin screen and by the tracker, both of which have to reach a review
// the lobby no longer offers. Never filter this one on `archived`.
export async function listAllCurations(limit = 100): Promise<CurationSummary[]> {
  const first = await supabase
    .from('review_curations')
    .select(ADMIN_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(limit);

  const { data, error } = first.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(ADMIN_COLUMNS_LEGACY)
        .order('updated_at', { ascending: false })
        .limit(limit)
    : first;

  if (error) {
    console.error('[curationsRepo] listAllCurations failed:', error);
    return [];
  }
  return ((data ?? []) as unknown as CurationListRow[]).map(rowToSummary);
}

/**
 * Which of these reviews an admin has put away.
 *
 * The lobby's "Your design reviews" follows the PERSON rather than the link:
 * lib/reviewParticipantsRepo reads review_participants and looks the titles up
 * by id afterwards, so it never sees a column of the curation row and cannot
 * filter on one. This is the other half of that lookup — one query for the
 * whole list — and the caller drops the ids that come back.
 *
 * Answers with nothing to hide on any failure, including the 42703 of a
 * database that has never heard of `archived` and so has nothing archived in
 * it. A list that could not check is an inconvenience; an empty one is not
 * what that database means.
 */
export async function listArchivedIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set<string>();
  const { data, error } = await supabase
    .from('review_curations')
    .select('id')
    .eq('archived', true)
    .in('id', ids);
  if (error) {
    console.error('[curationsRepo] listArchivedIds failed:', error);
    return new Set<string>();
  }
  const rows = (data ?? []) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * Delete a design review — all of it, not just its curation row.
 *
 * This used to be a `.delete()` at Supabase, which removed the review_curations row
 * and left the review's meetings, cards, lines, roster and stored revisions behind:
 * a tracker full of cards no review could be opened on. docs/supabase-schema.sql no
 * longer lets the published anon key delete a curation row at all (batch BN), and
 * the removal is `delete_review(p_review)` — one transaction, called by
 * api/reviews/delete.ts with the service role, which is also where the caller's role
 * is checked. lib/reviews/deleteClient.ts is this side of that.
 *
 * @returns whether the review is gone. A refusal — an editor rather than the owner
 *          on a deployment with accounts — answers false and logs the sentence the
 *          endpoint gave, which is the one worth showing if a caller ever grows a
 *          place to put it.
 */
export async function deleteCuration(id: string): Promise<boolean> {
  const result = await deleteReviewRequest(id);
  if (!result.ok) {
    console.error('[curationsRepo] deleteCuration failed:', result.error ?? 'refused');
    return false;
  }
  return true;
}

// Toggle a review's lobby visibility without touching any other column.
export async function setCurationListed(id: string, listed: boolean): Promise<boolean> {
  const { error } = await supabase
    .from('review_curations')
    .update({ listed })
    .eq('id', id);
  if (error) {
    console.error('[curationsRepo] setCurationListed failed:', error);
    return false;
  }
  return true;
}

/**
 * Name a design review, and nothing else about it.
 *
 * ONE COLUMN, deliberately, and not `saveCuration({...draft, title})`: the lobby's
 * preview panel renames a review it has only a summary of, and a whole-row upsert
 * from a summary would write back the viewpoints, pins and agenda it never read.
 * A rename made while a meeting is in progress then lands as the name and leaves
 * the meeting's own save to land the rest — which is the same last-writer-wins the
 * room already relies on, narrowed to the one field being changed.
 *
 * An empty name is refused rather than written: a review called "" is a card in the
 * lobby with nothing on it, and the person who pressed Enter in a field they did
 * not fill in meant to change nothing.
 */
export async function renameCuration(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
  const wanted = reviewTitleFrom(title, '');
  if (wanted === '') return { ok: false, error: 'Give the design review a name.' };
  const { error } = await supabase
    .from('review_curations')
    .update({ title: wanted })
    .eq('id', id);
  if (error) {
    console.error('[curationsRepo] renameCuration failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// Fetch a single curation summary by id — used when a contributor lands on
// the lobby via a room link and we want to preview what they're joining.
export async function getCurationSummary(id: string): Promise<CurationSummary | null> {
  const first = await supabase
    .from('review_curations')
    .select(SUMMARY_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  // No `thumbnail`: keep every filter and every other column this database does have.
  const second = first.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(SUMMARY_COLUMNS_NO_THUMBNAIL)
        .eq('id', id)
        .maybeSingle()
    : first;

  // No `listed` either: a database from before per-review visibility, in which every
  // review is listed by definition.
  const { data, error } = second.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select(SUMMARY_COLUMNS_LEGACY)
        .eq('id', id)
        .maybeSingle()
    : second;

  if (error || !data) return null;
  return rowToSummary(data as unknown as CurationListRow);
}

// Collect every distinct label value already used for each field across all
// reviews on this install. Powers the datalist suggestions in the free-text
// inputs of LabelsTab — one query for every field rather than one per field.
//
// `labels` is a jsonb column: { [fieldId]: stringValue }. We cap at 200 rows
// (newest first) to keep the query bounded. An install whose database
// predates the `labels` column gets an empty map — no suggestions, but no
// error either (same 42703 pattern as every other read above).
export async function listUsedLabelValues(): Promise<Record<string, string[]>> {
  const first = await supabase
    .from('review_curations')
    .select('labels')
    .order('created_at', { ascending: false })
    .limit(200);

  const { data, error } = first.error?.code === UNDEFINED_COLUMN
    ? await supabase
        .from('review_curations')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(200)
    : first;

  if (error) {
    console.error('[curationsRepo] listUsedLabelValues failed:', error);
    return {};
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const result: Record<string, Set<string>> = {};
  for (const row of rows) {
    const labels = row['labels'] as Record<string, string> | null | undefined;
    if (!labels || typeof labels !== 'object') continue;
    for (const [fieldId, value] of Object.entries(labels)) {
      if (typeof value !== 'string' || !value) continue;
      if (!result[fieldId]) result[fieldId] = new Set();
      result[fieldId].add(value);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [fieldId, values] of Object.entries(result)) {
    out[fieldId] = [...values].sort();
  }
  return out;
}

// ─── Live presence ───────────────────────────────────────────────────────────
// Built on Supabase Presence: each contributor opens a channel keyed by the
// curation id, tracks their identity, and receives the full peer list as it
// changes. No table writes — presence state lives only in the channel.

export interface CurationPresence {
  userId: string;
  name: string;
  color: string;
  joinedAt: number;
}

export function trackCurationPresence(
  id: string,
  self: Omit<CurationPresence, 'joinedAt'>,
  onSync: (peers: CurationPresence[]) => void,
): () => void {
  // No database, no realtime server: don't open a WebSocket that can only
  // fail and reconnect forever.
  if (!supabaseConfigured) return () => {};
  const channel = supabase.channel(`curation-presence:${id}`, {
    config: { presence: { key: self.userId } },
  });
  const emit = () => {
    const raw = channel.presenceState() as Record<string, CurationPresence[]>;
    const flat: CurationPresence[] = [];
    for (const arr of Object.values(raw)) {
      if (arr.length > 0) flat.push(arr[0]);
    }
    flat.sort((a, b) => a.joinedAt - b.joinedAt);
    onSync(flat);
  };
  channel
    .on('presence', { event: 'sync' }, emit)
    .on('presence', { event: 'join' }, emit)
    .on('presence', { event: 'leave' }, emit)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ ...self, joinedAt: Date.now() });
      }
    });
  return () => { supabase.removeChannel(channel); };
}

export type SyncStatus = 'connecting' | 'live' | 'polling' | 'offline';

// Subscribe to remote changes for a single curation row. Uses Supabase
// Realtime (postgres_changes) when available; falls back to polling every
// 5 seconds if the channel fails to subscribe (e.g., the publication line
// wasn't added to supabase_realtime). The status callback lets the UI
// show whether we're actually receiving live updates.
//
// Returns an unsubscribe function.
export function subscribeCuration(
  id: string,
  onChange: (draft: ReviewDraft) => void,
  onStatus?: (status: SyncStatus) => void,
): () => void {
  if (!supabaseConfigured) {
    onStatus?.('offline');
    return () => {};
  }
  let cancelled = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let realtimeOk = false;

  onStatus?.('connecting');

  const startPolling = () => {
    if (pollTimer || cancelled) return;
    onStatus?.(realtimeOk ? 'live' : 'polling');
    pollTimer = setInterval(async () => {
      if (cancelled) return;
      const draft = await loadCuration(id);
      if (!cancelled && draft) onChange(draft);
    }, 5000);
  };

  const stopPolling = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  const channel = supabase
    .channel(`curation:${id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'review_curations',
        filter: `id=eq.${id}`,
      },
      (payload) => {
        const row = payload.new as CurationRow | null;
        if (!row || !row.id) return;
        onChange(rowToDraft(row));
      },
    )
    .subscribe((status) => {
      // Supabase emits 'SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'.
      if (status === 'SUBSCRIBED') {
        realtimeOk = true;
        stopPolling();             // Realtime live → no need to poll.
        onStatus?.('live');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        realtimeOk = false;
        onStatus?.('polling');
        startPolling();            // Degrade gracefully — keep edits flowing.
      }
    });

  // Belt-and-suspenders: if the channel never reports SUBSCRIBED within 3s
  // (publication missing, network blocked, etc.), start polling anyway.
  const watchdog = setTimeout(() => {
    if (!realtimeOk) startPolling();
  }, 3000);

  return () => {
    cancelled = true;
    clearTimeout(watchdog);
    stopPolling();
    supabase.removeChannel(channel);
    onStatus?.('offline');
  };
}
