// MockNotificationSink — in-memory implementation for contract tests.

import type { NotificationSinkAdapter } from './types.ts';
import type { TrackerSession, TrackerItem } from '../../supabase.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

export class MockNotificationSink implements NotificationSinkAdapter {
  id = 'mock';
  postedSessions: Array<{ session: TrackerSession; items: TrackerItem[] }> = [];
  postedItems: TrackerItem[] = [];
  shouldFail = false;

  async postSession(
    session: TrackerSession,
    items: TrackerItem[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.shouldFail) return { ok: false, error: 'mock failure' };
    this.postedSessions.push({ session, items });
    return { ok: true };
  }

  async postItem(item: TrackerItem): Promise<{ ok: boolean; error?: string }> {
    if (this.shouldFail) return { ok: false, error: 'mock failure' };
    this.postedItems.push(item);
    return { ok: true };
  }

  /** Mirrors `shouldFail`, so the degraded path is drivable without a network. */
  async healthCheck(): Promise<HealthCheckResult> {
    if (this.shouldFail) {
      return { ok: false, detail: HEALTH_DETAILS.checkFailed };
    }
    return { ok: true, detail: HEALTH_DETAILS.selfContained };
  }
}
