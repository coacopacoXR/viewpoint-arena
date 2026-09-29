// POST /api/teamcenter/tasks
//
// Creates a task in Teamcenter via the Active Workspace REST API.
// The request body carries the tracker-item fields (title, description, etc.)
// — never credentials. The Teamcenter session ID is resolved server-side
// from the HttpOnly cookie set by /api/teamcenter/login.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withTCAuth } from './_lib.ts';

interface TaskBody {
  object_name: string;
  object_desc: string;
  task_type: string;
  due_date?: string;
  assigned_to?: string;
  reference_designator?: string;
  priority: number;
  fnd0status: string;
  viewpoint_item_id: string;
  viewpoint_item_type: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  await withTCAuth(req, res, async (session) => {
    const body = req.body as TaskBody;
    if (!body?.object_name) {
      res.status(400).json({ error: 'missing_object_name' });
      return;
    }

    const url = `${session.baseUrl}/tc/micro/wf/v1/tasks`;
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
      console.error('[teamcenter] create task failed', tcRes.status, text.slice(0, 200));
      res.status(tcRes.status).json({ error: 'tc_create_task_failed' });
      return;
    }

    const data = (await tcRes.json()) as { uid?: string; id?: string };
    res.status(200).json({ id: data.uid ?? data.id ?? 'created' });
  });
}
