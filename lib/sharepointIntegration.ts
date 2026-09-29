// WHY THIS FILE STAYS CLIENT-SIDE (do NOT move to api/*):
//
// SharePoint integration uses MSAL browser-delegated auth — the signed-in
// user's own Microsoft account token, not an app secret. This is legitimately
// a client-side flow by design (Microsoft's auth model, not ours to change):
// the user signs in via a popup, MSAL caches their token in the browser, and
// Graph API calls are made with that user's permissions.
//
// Moving this server-side would require an app-only (client-credentials) flow
// with a stored app secret, which is a fundamentally different auth model and
// would lose the per-user permission scoping that makes this safe.
//
// See docs/adapters/notify.md for the full rule.

import { PublicClientApplication, Configuration, AccountInfo } from '@azure/msal-browser';
import { TrackerItem } from './supabase';

export interface SharePointConfig {
  clientId: string;
  tenantId: string;
  siteId: string;
  listId: string;
}

const SCOPES = ['https://graph.microsoft.com/Sites.ReadWrite.All'];

let msalInstance: PublicClientApplication | null = null;

async function getMsal(config: SharePointConfig): Promise<PublicClientApplication> {
  if (msalInstance) return msalInstance;

  const msalConfig: Configuration = {
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: 'localStorage' },
  };

  msalInstance = new PublicClientApplication(msalConfig);
  await msalInstance.initialize();
  return msalInstance;
}

async function getAccessToken(config: SharePointConfig): Promise<string> {
  const msal = await getMsal(config);
  const accounts = msal.getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await msal.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] as AccountInfo });
      return result.accessToken;
    } catch {
      // Fall through to interactive
    }
  }

  const result = await msal.acquireTokenPopup({ scopes: SCOPES });
  return result.accessToken;
}

function mapItemToSpFields(item: TrackerItem): Record<string, unknown> {
  return {
    Title: item.title,
    Description: item.description ?? '',
    ItemType: item.type,
    Priority: item.priority,
    Status: item.status,
    Assignee: item.assignee ?? '',
    DueDate: item.due_date ? new Date(item.due_date).toISOString() : null,
    ComponentReference: item.component_reference ?? '',
    Department: item.department ?? '',
    SessionTitle: item.session?.title ?? '',
    SessionDate: item.session?.ended_at ? new Date(item.session.ended_at).toISOString() : null,
    Impact: item.impact ?? '',
    MitigationStrategy: item.mitigation_strategy ?? '',
    DesignDriver: item.design_driver ?? '',
    TradeoffAnalysis: item.tradeoff_analysis ?? '',
    ViewpointItemId: item.id,
  };
}

export async function syncItemsToSharePoint(
  config: SharePointConfig,
  items: TrackerItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: boolean; synced: number; errors: string[] }> {
  const token = await getAccessToken(config);
  const baseUrl = `https://graph.microsoft.com/v1.0/sites/${config.siteId}/lists/${config.listId}/items`;
  const errors: string[] = [];
  let synced = 0;

  for (const item of items) {
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: mapItemToSpFields(item) }),
      });

      if (!res.ok) {
        const body = await res.text();
        errors.push(`${item.title.slice(0, 40)}: ${res.status} ${body.slice(0, 100)}`);
      } else {
        synced++;
      }
    } catch (err) {
      errors.push(`${item.title.slice(0, 40)}: ${String(err)}`);
    }
    onProgress?.(synced + errors.length, items.length);
  }

  return { ok: errors.length === 0, synced, errors };
}

export function getSharePointConfig(): SharePointConfig | null {
  const env = import.meta.env;
  const clientId = env.VITE_MSAL_CLIENT_ID as string;
  const tenantId = env.VITE_MSAL_TENANT_ID as string;
  const siteId = env.VITE_SP_SITE_ID as string;
  const listId = env.VITE_SP_LIST_ID as string;

  if (clientId && tenantId && siteId && listId) return { clientId, tenantId, siteId, listId };

  try {
    const stored = localStorage.getItem('vp_sharepoint_config');
    if (stored) return JSON.parse(stored) as SharePointConfig;
  } catch { /* */ }

  return null;
}

export function saveSharePointConfig(config: SharePointConfig): void {
  localStorage.setItem('vp_sharepoint_config', JSON.stringify(config));
}
