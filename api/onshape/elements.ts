// Lists the elements (part studios + assemblies) inside a document workspace.
// The frontend uses this to populate the "pick something to import" list.
//
// GET /api/onshape/elements?d=<documentId>&w=<workspaceId>

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callOnshape, applyRefreshedCookies, withAuth } from '../_lib/onshape.js';

// Onshape's /elements endpoint returns each element with two type fields:
//  - `elementType`: enum string ("PARTSTUDIO" | "ASSEMBLY" | "DRAWING" | …)
//  - `type`: integer (0 = part studio, 1 = assembly, 2 = drawing, …) on some
//            API versions, string on others
// We normalize both into our own union and only surface 3D-usable elements.

interface OnshapeElement {
  id: string;
  name: string;
  type?: string | number;
  elementType?: string;
  microversionId?: string;
  thumbnailInfo?: { sizes?: { size: string; href: string }[] };
}

// Exported so lib/connectors/plm/onshape.ts can be tested against it for
// drift. The adapter keeps its own copy rather than importing this module,
// because this file is a Vercel handler and pulling it into the adapter's
// import graph would drag the serverless runtime in with it. The copies are
// pinned equal by a test — see lib/connectors/plm/onshapeTypeDrift.test.ts.
export const TYPE_INT_TO_STR: Record<number, string> = {
  0: 'PARTSTUDIO',
  1: 'ASSEMBLY',
  2: 'DRAWING',
  3: 'BLOB',
  4: 'APPLICATION',
  5: 'TABLE',
  6: 'BILLOFMATERIALS',
  7: 'FEATURESTUDIO',
  8: 'PUBLICATIONITEM',
  9: 'VARIABLESTUDIO',
};

export function normalizeType(e: OnshapeElement): string {
  if (e.elementType) return e.elementType.toUpperCase().replace(/\s+/g, '');
  if (typeof e.type === 'string') return e.type.toUpperCase().replace(/\s+/g, '');
  if (typeof e.type === 'number') return TYPE_INT_TO_STR[e.type] ?? '';
  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await withAuth(res, async () => {
    const d = typeof req.query.d === 'string' ? req.query.d : '';
    const w = typeof req.query.w === 'string' ? req.query.w : '';
    if (!d || !w) {
      res.status(400).json({ error: 'Missing d (document id) or w (workspace id)' });
      return;
    }

    const { response, refreshedCookies } = await callOnshape(req, `/api/v9/documents/d/${d}/w/${w}/elements`);
    applyRefreshedCookies(res, refreshedCookies);
    if (!response.ok) {
      res.status(response.status).json({ error: 'onshape_api_error', detail: await response.text() });
      return;
    }
    const items = await response.json() as OnshapeElement[];
    const normalized = items.map((e) => ({
      id: e.id,
      name: e.name,
      type: normalizeType(e),
      thumbnail: e.thumbnailInfo?.sizes?.[0]?.href,
    }));
    // Only surface things we can actually load.
    const trimmed = normalized.filter((e) => e.type === 'ASSEMBLY' || e.type === 'PARTSTUDIO');
    // Include the set of types we saw so the UI can explain *why* the list
    // might be empty (e.g. "this document only has drawings").
    const allTypes = Array.from(new Set(normalized.map((e) => e.type).filter(Boolean)));
    res.status(200).json({ items: trimmed, allTypes });
  });
}
