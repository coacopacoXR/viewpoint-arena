// Models admin endpoint (plan 14, batch BE).
//
// GET    /api/admin/models                        — list every file storage holds,
//                                                  with the references from
//                                                  revisions and curation assets.
//                                                  Files no design review points at
//                                                  are listed too, marked
//                                                  `referenced: false`: a model
//                                                  uploaded in a plain session has
//                                                  no row anywhere, and a file the
//                                                  console cannot show is a file
//                                                  nobody can delete.
// DELETE /api/admin/models?type=revision&id=...   — remove a model_revisions row.
// DELETE /api/admin/models?type=file&hash=...     — remove a file from storage,
//                                                  only when nothing references
//                                                  its hash any more (409 otherwise).
//
// Both behind requireAdmin.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../_lib/adminAuth.ts';
import { postgrestFetch } from '../_lib/postgrest.ts';
import { resolveModelStore } from '../_lib/models.ts';
import { isModelHash } from '../../lib/storage/hash.ts';
import type { ModelListEntry } from '../../lib/storage/modelStore.ts';

interface RevisionRow {
  id: string;
  review_id: string;
  line: string;
  revision: string;
  hash: string;
  file_name: string;
  size: number;
  uploaded_by: string | null;
  uploaded_by_name: string;
  created_at: string;
}

interface CurationRow {
  id: string;
  title: string;
  asset: { modelHash?: string } | null;
}

interface ModelRevisionRef {
  id: string;
  review_id: string;
  review_title: string;
  line: string;
  revision: string;
}

interface CurationRef {
  review_id: string;
  review_title: string;
}

interface AdminModelEntry {
  hash: string;
  file_name: string;
  size: number;
  content_type: string;
  uploaded_at: string;
  uploaded_by_name: string;
  /**
   * Whether a revision row or a curation asset points at this hash. False means
   * the file is in storage and no design review uses it — the console says so,
   * and deleting it is exactly what the DELETE route's 409 guard allows.
   */
  referenced: boolean;
  revisions: ModelRevisionRef[];
  curation_refs: CurationRef[];
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  // Use requireAdmin's answer, as every other admin endpoint does. Inferring
  // failure from res.writableEnded would let a response object that does not
  // track it (a shim, a mock) fall through to deleting files unauthenticated.
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      await handleList(res);
    } else if (req.method === 'DELETE') {
      await handleDelete(req, res);
    } else {
      res.setHeader('Allow', 'GET, DELETE');
      res.status(405).json({ error: 'method_not_allowed' });
    }
  } catch (err) {
    console.error('[admin/models] unhandled:', err);
    res.status(500).json({ error: 'internal_error' });
  }
}

async function handleList(res: VercelResponse) {
  const [revisionsRes, curationsRes] = await Promise.all([
    postgrestFetch(
      'model_revisions?select=id,review_id,line,revision,hash,file_name,size,uploaded_by,uploaded_by_name,created_at&order=created_at.desc&limit=500',
    ),
    postgrestFetch(
      'review_curations?select=id,title,asset&limit=200',
    ),
  ]);

  if (!revisionsRes || !curationsRes) {
    res.status(503).json({ error: 'store_unavailable' });
    return;
  }
  if (!revisionsRes.ok || !curationsRes.ok) {
    console.error(
      `[admin/models] list failed: revisions=${revisionsRes.status} curations=${curationsRes.status}`,
    );
    res.status(502).json({ error: 'upstream_error' });
    return;
  }

  const revisions = (await revisionsRes.json()) as RevisionRow[];
  const curations = (await curationsRes.json()) as CurationRow[];

  // Group revisions by hash.
  const byHash = new Map<string, {
    revisions: RevisionRow[];
    curation_refs: CurationRef[];
  }>();

  for (const rev of revisions) {
    let entry = byHash.get(rev.hash);
    if (!entry) {
      entry = { revisions: [], curation_refs: [] };
      byHash.set(rev.hash, entry);
    }
    entry.revisions.push(rev);
  }

  // Find curation asset references.
  const reviewTitles = new Map<string, string>();
  for (const c of curations) {
    reviewTitles.set(c.id, c.title);
    const hash = c.asset?.modelHash;
    if (hash && typeof hash === 'string') {
      let entry = byHash.get(hash);
      if (!entry) {
        entry = { revisions: [], curation_refs: [] };
        byHash.set(hash, entry);
      }
      entry.curation_refs.push({ review_id: c.id, review_title: c.title });
    }
  }

  // Every file storage holds, described by the store rather than by a caller's
  // hash. The two queries above only know about files a design review points
  // at, so a model imported in a plain session is in neither — and a file this
  // listing does not add is a file the console cannot show, which is a file
  // nobody can delete. The metadata comes with it, so the referenced hashes are
  // described by the same one listing instead of by a `head` each.
  const store = await resolveModelStore();
  const storedByHash = new Map<string, ModelListEntry>();
  if (store) {
    try {
      for (const stored of await store.list()) {
        storedByHash.set(stored.hash, stored);
        if (!byHash.has(stored.hash)) {
          byHash.set(stored.hash, { revisions: [], curation_refs: [] });
        }
      }
    } catch (err) {
      // Degrade to the database's answer — the referenced files, described by
      // their revision rows — rather than 500 the whole section, and say why in
      // the api log. The console then shows fewer files than storage holds,
      // which is the old behaviour and a lesser harm than no models section.
      console.error('[admin/models] store listing failed:', err);
    }
  }

  const entries: AdminModelEntry[] = [];
  let totalStorage = 0;

  for (const [hash, { revisions: revs, curation_refs }] of byHash) {
    const meta = storedByHash.get(hash);
    const firstRev = revs[0];
    const fileName = meta?.fileName ?? firstRev?.file_name ?? '';
    const size = meta?.size ?? firstRev?.size ?? 0;
    const contentType = meta?.contentType ?? '';
    const uploadedAt = meta?.uploadedAt ?? firstRev?.created_at ?? '';
    const uploadedByName = firstRev?.uploaded_by_name ?? '';

    entries.push({
      hash,
      file_name: fileName,
      size,
      content_type: contentType,
      uploaded_at: uploadedAt,
      uploaded_by_name: uploadedByName,
      referenced: revs.length > 0 || curation_refs.length > 0,
      revisions: revs.map((r) => ({
        id: r.id,
        review_id: r.review_id,
        review_title: reviewTitles.get(r.review_id) ?? r.review_id,
        line: r.line,
        revision: r.revision,
      })),
      curation_refs,
    });
    totalStorage += size;
  }

  // Sort by uploaded_at descending.
  entries.sort((a, b) => (b.uploaded_at > a.uploaded_at ? 1 : -1));

  res.status(200).json({ models: entries, total_storage: totalStorage });
}

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const type = readStringParam(req, 'type');
  if (!type) {
    res.status(400).json({ error: 'type is required (revision or file)' });
    return;
  }

  if (type === 'revision') {
    await handleDeleteRevision(req, res);
  } else if (type === 'file') {
    await handleDeleteFile(req, res);
  } else {
    res.status(400).json({ error: 'type must be revision or file' });
  }
}

async function handleDeleteRevision(req: VercelRequest, res: VercelResponse) {
  const id = readStringParam(req, 'id');
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  const delRes = await postgrestFetch(
    `model_revisions?id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
  );
  if (!delRes) {
    res.status(503).json({ error: 'store_unavailable' });
    return;
  }
  if (!delRes.ok) {
    console.error(`[admin/models] revision delete failed: ${delRes.status}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  res.status(200).json({ ok: true });
}

async function handleDeleteFile(req: VercelRequest, res: VercelResponse) {
  const hash = readStringParam(req, 'hash');
  if (!hash) {
    res.status(400).json({ error: 'hash is required' });
    return;
  }
  if (!isModelHash(hash)) {
    res.status(400).json({ error: 'invalid_hash' });
    return;
  }

  // Check references: model_revisions and review_curations.asset.modelHash.
  const [revRes, curRes] = await Promise.all([
    postgrestFetch(
      `model_revisions?id=gt.0&hash=eq.${encodeURIComponent(hash)}&select=id&limit=1`,
    ),
    postgrestFetch('review_curations?select=id,asset&limit=200'),
  ]);

  if (!revRes || !curRes) {
    res.status(503).json({ error: 'store_unavailable' });
    return;
  }

  // Check revision references.
  if (revRes.ok) {
    const revRows = (await revRes.json()) as Array<{ id: string }>;
    if (revRows.length > 0) {
      res.status(409).json({
        error: 'This file is still referenced by a model revision. Delete the revision first.',
      });
      return;
    }
  }

  // Check curation asset references.
  if (curRes.ok) {
    const curRows = (await curRes.json()) as CurationRow[];
    const referenced = curRows.some((c) => c.asset?.modelHash === hash);
    if (referenced) {
      res.status(409).json({
        error: 'This file is still referenced by a design review. Change the review\'s model first.',
      });
      return;
    }
  }

  // Safe to delete from storage.
  const store = await resolveModelStore();
  if (!store) {
    res.status(503).json({ error: 'storage_unavailable' });
    return;
  }

  const removed = await store.delete(hash);
  res.status(200).json({ ok: true, removed });
}

function readStringParam(req: VercelRequest, name: string): string | null {
  const raw = req.query[name];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

export default handler;
