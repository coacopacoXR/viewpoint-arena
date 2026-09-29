# Notification Sink Adapters

Implements `NotificationSinkAdapter` from `docs/plan/02-connector-adapters.md §4`.

## Interface

```ts
interface NotificationSinkAdapter {
  id: string;
  postSession(session: TrackerSession, items: TrackerItem[]): Promise<{ ok: boolean; error?: string }>;
  postItem(item: TrackerItem): Promise<{ ok: boolean; error?: string }>;
}
```

## Implementations

| Adapter | Location | Auth model | Notes |
|---|---|---|---|
| Teams | `lib/connectors/notify/teams.ts` + `api/notify/teams.ts` | Server-side webhook URL (`TEAMS_WEBHOOK_URL` in `process.env`) | Card-building logic in the server handler. Browser client never holds the webhook URL. |
| Teamcenter | `lib/connectors/notify/teamcenter.ts` | Server-side session cookie (via `api/teamcenter/*`) | Delegates to `TeamcenterPLMAdapter.pushActions()`. |
| SharePoint | `lib/sharepointIntegration.ts` | **Client-side MSAL user-delegated auth** | See exception below. |

## Contract testing

Run the shared suite against any implementation:

```ts
import { runNotifyContractTests } from './notify.contract.test.ts';

runNotifyContractTests('MyAdapter', () => ({
  adapter: new MyAdapter(),
  session: mockSession,
  items: [mockItem],
  item: mockItem,
}));
```

## SharePoint exception — why it stays client-side

`lib/sharepointIntegration.ts` uses MSAL browser-delegated auth: the signed-in
user's own Microsoft account token, not an app secret. This is legitimately a
client-side flow by design (Microsoft's auth model). Moving it server-side
would require an app-only (client-credentials) flow with a stored app secret,
which is a fundamentally different auth model and would lose per-user
permission scoping.

**Rule**: if an integration uses the end-user's own delegated token (OAuth2
authorization code flow with PKCE, MSAL popup login, etc.), it stays
client-side. If it uses a service account or app secret, it moves server-side.
