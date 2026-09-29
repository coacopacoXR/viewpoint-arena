// Streams the GLB binary from Onshape's externaldata endpoint once the
// translation has finished. The browser calls this after translate-status
// reports DONE with documentId + dataId.
//
// GET /api/onshape/translate-download?did=<documentId>&dataId=<externalDataId>

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callOnshape, applyRefreshedCookies, withAuth } from '../_lib/onshape.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await withAuth(res, async () => {
    const did = typeof req.query.did === 'string' ? req.query.did : '';
    const dataId = typeof req.query.dataId === 'string' ? req.query.dataId : '';
    if (!did || !dataId) {
      res.status(400).json({ error: 'Missing did or dataId' });
      return;
    }
    const { response, refreshedCookies } = await callOnshape(req, `/api/v9/documents/d/${did}/externaldata/${dataId}`);
    applyRefreshedCookies(res, refreshedCookies);
    if (!response.ok) {
      res.status(response.status).json({ error: 'download_failed', detail: await response.text() });
      return;
    }
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Content-Disposition', `inline; filename="onshape-${dataId}.glb"`);
    res.status(200).send(Buffer.from(await response.arrayBuffer()));
  });
}
