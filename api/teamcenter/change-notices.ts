// POST /api/teamcenter/change-notices
//
// Creates a change notice in Teamcenter via the Active Workspace REST API.
// Mirrors api/teamcenter/tasks.ts — body carries tracker-item fields,
// credentials are resolved server-side from the HttpOnly session cookie.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withTCAuth } from './_lib.ts';

interface CNBody {
  object_name: string;
  object_desc: string;
  cm0Due_date?: string;
  cm0Assigned_user?: string;
  cm0Priority: string;
  cm0Severity: string;
  cm0Affected_items: Array<{ object_name: string }>;
  viewpoint_item_id: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  await withTCAuth(req, res, async (session) => {
    const body = req.body as CNBody;
    if (!body?.object_name) {
      res.status(400).json({ error: 'missing_object_name' });
      return;
    }

    const url = `${session.baseUrl}/tc/micro/change/v1/changenotices`;
    const tcRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': session.tcSessionId,
      },
      body: JSON.stringify(body),
    });

    if (!tcRes.ok) {
      const text = await tcRes.text();
      console.error('[teamcenter] create CN failed', tcRes.status, text.slice(0, 200));
      res.status(tcRes.status).json({ error: 'tc_create_cn_failed' });
      return;
    }

    const data = (await tcRes.json()) as { uid?: string; id?: string };
    res.status(200).json({ id: data.uid ?? data.id ?? 'created' });
  });
}
