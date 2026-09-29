// Single-poll status check for an Onshape translation. The browser calls
// this every few seconds until requestState is DONE or FAILED.
//
// GET /api/onshape/translate-status?id=<translationId>

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callOnshape, applyRefreshedCookies, withAuth } from '../_lib/onshape.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await withAuth(res, async () => {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }
    const { response, refreshedCookies } = await callOnshape(req, `/api/v9/translations/${id}`);
    applyRefreshedCookies(res, refreshedCookies);
    if (!response.ok) {
      res.status(response.status).json({ error: 'status_check_failed', detail: await response.text() });
      return;
    }
    const status = await response.json() as {
      requestState: string;
      resultExternalDataIds?: string[];
      documentId?: string;
      failureReason?: string;
    };
    res.status(200).json({
      state: status.requestState,
      documentId: status.documentId,
      dataId: status.resultExternalDataIds?.[0],
      failureReason: status.failureReason,
    });
  });
}
