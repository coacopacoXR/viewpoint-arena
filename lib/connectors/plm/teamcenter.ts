// TeamcenterPLMAdapter — browser-safe client implementing PLMAdapter.
//
// All Teamcenter API calls go through server-side Vercel functions
// (api/teamcenter/*). Credentials live in server-side process.env and NEVER
// reach this module. No method accepts a credential as an argument.
//
// In addition to the PLMAdapter interface, this adapter exposes pushActions()
// and pushRisks() for pushing tracker items to Teamcenter as tasks or change
// notices — the functionality relocated from the old lib/teamcenterIntegration.ts.

import type {
  PLMAdapter,
  PLMAuthContext,
  PLMDocumentRef,
  PLMElement,
} from './types.ts';
import type { TrackerItem } from '../../supabase.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';
import { isGenericPlmId } from './launchParams.ts';

type FetchFn = typeof globalThis.fetch;

const PRIORITY_MAP: Record<string, number> = {
  Critical: 1,
  High: 2,
  Medium: 3,
  Low: 4,
};

export interface TeamcenterPushResult {
  ok: boolean;
  pushed: number;
  errors: string[];
  ids: string[];
}

export class TeamcenterPLMAdapter implements PLMAdapter {
  authStartPath = '/api/teamcenter/login';

  private _fetch: FetchFn;
  private _loggedIn = false;
  private _sessionCookie = '';

  constructor(fetchFn?: FetchFn) {
    this._fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  private get cookieHeader(): string {
    return this._sessionCookie ? `vp_tc_session=${this._sessionCookie}` : '';
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this._loggedIn) return;
    const resp = await this._fetch('/api/teamcenter/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(
        `teamcenter: login failed (${resp.status}: ${(data as { error?: string }).error ?? 'unknown'})`,
      );
    }
    // Capture session cookie from Set-Cookie response header (for test envs
    // where the browser cookie jar isn't available). In production the
    // browser handles this automatically.
    const setCookie = resp.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const match = c.match(/^vp_tc_session=([^;]+)/);
      if (match) {
        this._sessionCookie = match[1];
        break;
      }
    }
    this._loggedIn = true;
  }

  private async tcFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    await this.ensureLoggedIn();
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (this.cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', this.cookieHeader);
    }
    return this._fetch(path, { ...init, headers });
  }

  // The push side (tasks, change notices) is fully ported from the old
  // lib/teamcenterIntegration.ts and backed by real endpoints. The read side
  // is NOT: api/teamcenter/{documents,elements,export} do not exist yet,
  // because the old integration had no read-side logic and inventing a
  // Teamcenter REST contract would be speculation. Those routes therefore 404
  // in a real deployment. Turn that into an actionable message instead of a
  // bare HTTP error, so a caller can tell "not built yet" from "server down".
  private notImplemented(method: string, status: number): Error {
    if (status === 404) {
      return new Error(
        `teamcenter: ${method} is not implemented — api/teamcenter/` +
          `{documents,elements,export} do not exist yet. The Teamcenter read ` +
          `path is unfinished; see docs/plan/08-task-breakdown.md T3.2.`,
      );
    }
    return new Error(`teamcenter: ${method} failed (${status})`);
  }

  // ─── PLMAdapter interface ───────────────────────────────────────────

  async listDocuments(_auth: PLMAuthContext): Promise<PLMDocumentRef[]> {
    const resp = await this.tcFetch('/api/teamcenter/documents');
    if (!resp.ok) {
      throw this.notImplemented('listDocuments', resp.status);
    }
    const data = (await resp.json()) as {
      items: Array<{ id: string; workspaceId?: string }>;
    };
    return (data.items || []).map((d) => ({
      id: d.id,
      workspaceId: d.workspaceId,
    }));
  }

  async getElement(
    _auth: PLMAuthContext,
    ref: PLMDocumentRef,
  ): Promise<PLMElement> {
    const resp = await this.tcFetch(
      `/api/teamcenter/elements?id=${encodeURIComponent(ref.id)}`,
    );
    if (!resp.ok) {
      // A 404 here is ambiguous: the endpoint itself does not exist yet, so it
      // cannot mean "no such document". Say so rather than inventing a
      // not-found that the server never actually reported.
      throw this.notImplemented('getElement', resp.status);
    }
    const data = (await resp.json()) as PLMElement;
    return data;
  }

  async exportGeometry(
    _auth: PLMAuthContext,
    ref: PLMDocumentRef,
    format: 'gltf',
  ): Promise<Blob> {
    if (format !== 'gltf') {
      throw new Error(`teamcenter: unsupported format: ${format}`);
    }
    const resp = await this.tcFetch(
      `/api/teamcenter/export?id=${encodeURIComponent(ref.id)}&format=gltf`,
    );
    if (!resp.ok) {
      throw this.notImplemented('exportGeometry', resp.status);
    }
    const buf = await resp.arrayBuffer();
    return new Blob([buf], { type: 'model/gltf-binary' });
  }

  async resolveLaunchContext(
    query: Record<string, string>,
  ): Promise<{ roomHint: string; doc: PLMDocumentRef } | null> {
    if (query.plmSource !== 'teamcenter') return null;
    const docId = query.plmDoc;
    // Re-validate here even though lib/connectors/plm/launchParams.ts already
    // did: a corp calling this adapter straight from its own launch handler
    // must not depend on that module having run first. A Teamcenter UID is
    // opaque, but it may not contain a path or query separator — see
    // isGenericPlmId.
    if (!docId || !isGenericPlmId(docId)) return null;
    const workspaceId = query.plmWorkspace;
    if (workspaceId && !isGenericPlmId(workspaceId)) return null;
    const elementId = query.plmElement;
    if (elementId && !isGenericPlmId(elementId)) return null;
    return {
      // A label only, never a room id — see PLMAdapter.resolveLaunchContext.
      roomHint: `tc-${docId}`,
      doc: { id: docId, workspaceId, elementId },
    };
  }

  /**
   * Is the server-side route this adapter depends on there and answering?
   *
   * It checks the route, NOT the Teamcenter credentials, and that limit is
   * deliberate:
   *
   *  - This adapter is browser-safe and holds no credential, so it cannot
   *    verify one. TC_USERNAME / TC_PASSWORD live in server-side process.env
   *    behind api/teamcenter/*.
   *  - The only way to verify them is a real login, and /api/health is polled.
   *    Authenticating to a customer's Teamcenter on every poll would hammer
   *    their SSO and can trip account lockout — a health check that breaks the
   *    thing it checks is worse than a weaker check.
   *
   * So this answers "is the Teamcenter API surface deployed", which is the
   * failure an installer actually hits: a build with no api/teamcenter/*
   * functions 404s here, and that is reported rather than discovered by a user
   * mid-review. 405 is the expected answer (the route only accepts POST) and
   * means the handler ran.
   *
   * No status text, no response body and no URL is repeated: only the fixed
   * phrase. The existing isConfigured() is left alone — it reads `resp.ok`, so
   * it reports false against the 405 this route returns for a HEAD, and
   * changing it would change behaviour a caller may depend on.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    let status: number;
    try {
      const response = await this._fetch('/api/teamcenter/login', {
        method: 'HEAD',
      });
      status = response.status;
    } catch {
      return { ok: false, detail: HEALTH_DETAILS.unreachable };
    }
    if (status === 404) return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
    if (status === 503) return { ok: false, detail: HEALTH_DETAILS.notConfigured };
    if (status >= 500) return { ok: false, detail: HEALTH_DETAILS.upstreamError };
    return { ok: true, detail: HEALTH_DETAILS.routeReachable };
  }

  // ─── Teamcenter-specific push operations ────────────────────────────

  async isConfigured(): Promise<boolean> {
    try {
      const resp = await this._fetch('/api/teamcenter/login', {
        method: 'HEAD',
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async pushActions(
    items: TrackerItem[],
    mode: 'tasks' | 'change_notices' = 'tasks',
    onProgress?: (done: number, total: number) => void,
  ): Promise<TeamcenterPushResult> {
    const actionItems = items.filter((i) => i.type === 'ACTION');
    const errors: string[] = [];
    const ids: string[] = [];

    for (const item of actionItems) {
      try {
        const id =
          mode === 'change_notices'
            ? await this.createChangeNotice(item)
            : await this.createTask(item);
        ids.push(id);
      } catch (err) {
        errors.push(
          `${item.title.slice(0, 40)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      onProgress?.(ids.length + errors.length, actionItems.length);
    }

    return { ok: errors.length === 0, pushed: ids.length, errors, ids };
  }

  async pushRisks(
    items: TrackerItem[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<TeamcenterPushResult> {
    return this.pushActions(
      items
        .filter((i) => i.type === 'RISK')
        .map((i) => ({ ...i, type: 'ACTION' as const })),
      'change_notices',
      onProgress,
    );
  }

  // ─── Private request builders (ported from teamcenterIntegration.ts) ─

  private async createTask(item: TrackerItem): Promise<string> {
    const body = {
      object_name: item.title,
      object_desc: [item.description, item.impact, item.mitigation_strategy]
        .filter(Boolean)
        .join('\n\n'),
      task_type: 'Do',
      due_date: item.due_date
        ? new Date(item.due_date).toISOString()
        : undefined,
      assigned_to: item.assignee ?? undefined,
      reference_designator: item.component_reference ?? undefined,
      priority: PRIORITY_MAP[item.priority],
      fnd0status: 'Not Started',
      viewpoint_item_id: item.id,
      viewpoint_item_type: item.type,
    };

    const resp = await this.tcFetch('/api/teamcenter/tasks', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Create task failed (${resp.status})`);
    }
    const data = (await resp.json()) as { id?: string };
    return data.id ?? 'created';
  }

  private async createChangeNotice(item: TrackerItem): Promise<string> {
    const body = {
      object_name: item.title,
      object_desc: [item.description, item.impact, item.mitigation_strategy]
        .filter(Boolean)
        .join('\n\n'),
      cm0Due_date: item.due_date
        ? new Date(item.due_date).toISOString()
        : undefined,
      cm0Assigned_user: item.assignee ?? undefined,
      cm0Priority: item.priority,
      cm0Severity:
        item.priority === 'Critical'
          ? 'Safety'
          : item.priority === 'High'
            ? 'Major'
            : 'Minor',
      cm0Affected_items: item.component_reference
        ? [{ object_name: item.component_reference }]
        : [],
      viewpoint_item_id: item.id,
    };

    const resp = await this.tcFetch('/api/teamcenter/change-notices', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Create CN failed (${resp.status})`);
    }
    const data = (await resp.json()) as { id?: string };
    return data.id ?? 'created';
  }
}
