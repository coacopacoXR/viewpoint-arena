// POST /api/notify/teams
// HEAD /api/notify/teams  (configuration check)
//
// Server-side Teams webhook poster. The webhook URL is read from
// process.env.TEAMS_WEBHOOK_URL — never from the request, never from the
// client bundle. The card-building logic was relocated from the old
// lib/teamsIntegration.ts.
//
// SECURITY: the webhook URL is a bearer credential. It must never appear in
// any response body, error message, or log output that could reach the browser.

import type { VercelRequest, VercelResponse } from '@vercel/node';

interface TrackerItemLike {
  id: string;
  type: 'RISK' | 'RATIONALE' | 'ACTION';
  title: string;
  description: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'Open' | 'In Review' | 'Approved' | 'Rejected';
  assignee: string | null;
  due_date: string | null;
  component_reference: string | null;
  impact: string | null;
  mitigation_strategy: string | null;
}

interface TrackerSessionLike {
  title: string;
  ended_at: string;
  participant_count: number;
  model_name: string | null;
}

interface SessionPayload {
  action: 'session';
  session: TrackerSessionLike;
  items: TrackerItemLike[];
  origin?: string;
}

interface ItemPayload {
  action: 'item';
  item: TrackerItemLike;
  origin?: string;
}

type Payload = SessionPayload | ItemPayload;

// ─── Card builders (relocated from lib/teamsIntegration.ts) ─────────────────

function priorityEmoji(p: TrackerItemLike['priority']): string {
  return { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '⚪' }[p];
}

function statusEmoji(s: TrackerItemLike['status']): string {
  return { Open: '🔓', 'In Review': '🔵', Approved: '✅', Rejected: '❌' }[s];
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function buildSessionCard(
  session: TrackerSessionLike,
  items: TrackerItemLike[],
  origin: string,
) {
  const risks = items.filter((i) => i.type === 'RISK');
  const actions = items.filter((i) => i.type === 'ACTION');
  const rationale = items.filter((i) => i.type === 'RATIONALE');
  const critical = items.filter(
    (i) =>
      i.priority === 'Critical' &&
      i.status !== 'Approved' &&
      i.status !== 'Rejected',
  );
  const overdue = items.filter(
    (i) =>
      i.due_date &&
      new Date(i.due_date) < new Date() &&
      i.status !== 'Approved' &&
      i.status !== 'Rejected',
  );

  const topItems = critical.slice(0, 3);

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body: [
            {
              type: 'Container',
              style: 'emphasis',
              items: [
                {
                  type: 'TextBlock',
                  text: '📐 Viewpoint Arena — Design Review',
                  weight: 'Bolder',
                  size: 'Medium',
                  color: 'Accent',
                },
                {
                  type: 'TextBlock',
                  text: session.title,
                  weight: 'Bolder',
                  size: 'Large',
                  wrap: true,
                },
                {
                  type: 'TextBlock',
                  text: `${fmt(session.ended_at)} · ${session.participant_count} participants${session.model_name ? ` · ${session.model_name}` : ''}`,
                  size: 'Small',
                  isSubtle: true,
                },
              ],
            },
            {
              type: 'ColumnSet',
              columns: [
                {
                  type: 'Column',
                  width: 'stretch',
                  items: [
                    {
                      type: 'TextBlock',
                      text: `**${risks.length}**\nRisks`,
                      wrap: true,
                      horizontalAlignment: 'Center',
                    },
                  ],
                },
                {
                  type: 'Column',
                  width: 'stretch',
                  items: [
                    {
                      type: 'TextBlock',
                      text: `**${actions.length}**\nActions`,
                      wrap: true,
                      horizontalAlignment: 'Center',
                    },
                  ],
                },
                {
                  type: 'Column',
                  width: 'stretch',
                  items: [
                    {
                      type: 'TextBlock',
                      text: `**${rationale.length}**\nRationale`,
                      wrap: true,
                      horizontalAlignment: 'Center',
                    },
                  ],
                },
                {
                  type: 'Column',
                  width: 'stretch',
                  items: [
                    {
                      type: 'TextBlock',
                      text: `**${overdue.length}**\nOverdue`,
                      color:
                        overdue.length > 0 ? 'Attention' : 'Default',
                      wrap: true,
                      horizontalAlignment: 'Center',
                    },
                  ],
                },
              ],
            },
            ...(topItems.length > 0
              ? [
                  {
                    type: 'Container',
                    items: [
                      {
                        type: 'TextBlock',
                        text: '🔴 Critical Items',
                        weight: 'Bolder',
                        size: 'Small',
                      },
                      ...topItems.map((item) => ({
                        type: 'TextBlock' as const,
                        text: `${priorityEmoji(item.priority)} ${statusEmoji(item.status)} **[${item.type}]** ${item.title}`,
                        wrap: true,
                        size: 'Small',
                        spacing: 'Small',
                      })),
                    ],
                  },
                ]
              : []),
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'Open Tracker',
              url: `${origin}/tracker`,
              style: 'positive',
            },
          ],
          msteams: { width: 'Full' },
        },
      },
    ],
  };
}

function buildItemCard(item: TrackerItemLike, origin: string) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.5',
          body: [
            {
              type: 'TextBlock',
              text: `${priorityEmoji(item.priority)} [${item.type}] ${item.priority}`,
              weight: 'Bolder',
              color:
                item.priority === 'Critical' ? 'Attention' : 'Default',
            },
            {
              type: 'TextBlock',
              text: item.title,
              wrap: true,
              weight: 'Bolder',
              size: 'Medium',
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Status', value: item.status },
                ...(item.assignee
                  ? [{ title: 'Assignee', value: item.assignee }]
                  : []),
                ...(item.due_date
                  ? [{ title: 'Due', value: fmt(item.due_date) }]
                  : []),
                ...(item.component_reference
                  ? [{ title: 'Component', value: item.component_reference }]
                  : []),
              ],
            },
            ...(item.description
              ? [
                  {
                    type: 'TextBlock' as const,
                    text: item.description,
                    wrap: true,
                    isSubtle: true,
                    size: 'Small',
                  },
                ]
              : []),
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'Open Tracker',
              url: `${origin}/tracker`,
            },
          ],
        },
      },
    ],
  };
}

// ─── Sanitize error messages — never include the webhook URL ────────────────

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip anything that looks like a URL (the webhook URL could appear in
  // fetch error messages like "POST https://...webhook.office.com/... failed").
  return raw.replace(/https?:\/\/[^\s)'"]+/g, '<redacted>');
}

// ─── Handler ────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;

  if (req.method === 'HEAD') {
    res.status(webhookUrl ? 200 : 503).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!webhookUrl) {
    res.status(503).json({ error: 'teams_not_configured' });
    return;
  }

  const payload = req.body as Payload;
  if (!payload?.action) {
    res.status(400).json({ error: 'missing_action' });
    return;
  }

  const origin = payload.origin || 'https://viewpoint-arena.app';

  let card: unknown;
  if (payload.action === 'session') {
    if (!payload.session || !payload.items) {
      res.status(400).json({ error: 'missing_session_or_items' });
      return;
    }
    card = buildSessionCard(payload.session, payload.items, origin);
  } else if (payload.action === 'item') {
    if (!payload.item) {
      res.status(400).json({ error: 'missing_item' });
      return;
    }
    card = buildItemCard(payload.item, origin);
  } else {
    res.status(400).json({ error: 'unknown_action' });
    return;
  }

  try {
    const webhookRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!webhookRes.ok) {
      // Read the upstream error but never forward the webhook URL.
      await webhookRes.text().catch(() => {});
      console.error(
        `[notify/teams] webhook returned ${webhookRes.status}`,
      );
      res.status(502).json({ error: 'teams_webhook_error' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    // Never forward the raw error — it may contain the webhook URL.
    console.error('[notify/teams] fetch failed', sanitizeError(err));
    res.status(502).json({ error: 'teams_webhook_unreachable' });
  }
}
