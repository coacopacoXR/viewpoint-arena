// OpenAICaptureProvider — browser-safe TranscriptCaptureProvider.
//
// Holds no credential and cannot be given one: there is no key option, and
// nothing in this file reads process.env or import.meta.env. The transcript goes
// to our own serverless function (api/capture/extract.ts) and comes back as
// cards.
//
// Since plan 14 batch BF this class no longer names a vendor to the server, and
// that is not an oversight: lib/ai/router.ts decides which AI extracts the cards,
// from the admin console's AI section, from viewpoint.config.ts, or from the
// built-in stack. What is left here is the browser-side half of the
// TranscriptCaptureProvider contract — the shape a caller can rely on whichever
// provider answers — which is why there is no SDK integration in this file.
// See docs/plan/02-connector-adapters.md §2: "never call these directly from
// the browser with a key".

import type { InsightCard } from '../../../types';
import type {
  SlideContext,
  TranscriptCaptureProvider,
  TranscriptChunk,
} from './types';
import type { ExtractClientOptions } from './extractClient';
import {
  extractInsightsViaEndpoint,
  probeExtractEndpoint,
} from './extractClient';
import type { HealthCheckResult } from '../../health/types';
import { HEALTH_DETAILS } from '../../health/details';

export type OpenAICaptureOptions = ExtractClientOptions;

export class OpenAICaptureProvider implements TranscriptCaptureProvider {
  private readonly _options: OpenAICaptureOptions;

  constructor(options: OpenAICaptureOptions = {}) {
    this._options = options;
  }

  async extractInsights(
    transcript: TranscriptChunk[],
    context: SlideContext,
  ): Promise<InsightCard[]> {
    return extractInsightsViaEndpoint(transcript, context, this._options);
  }

  /** True when the extraction endpoint is deployed and unlocked. Never a key. */
  async isConfigured(): Promise<boolean> {
    return probeExtractEndpoint(this._options);
  }

  /**
   * Can the server-side extraction endpoint be reached?
   *
   * This is the only thing a browser-side provider can honestly check: the
   * credential and the choice of AI both live server-side and neither is sent
   * here, so "is OpenAI configured" is not a question this module can answer —
   * the admin console's AI section is. The HEAD probe reports whether the
   * endpoint is deployed and unlocked at all.
   *
   * It never runs an extraction: that would spend money on every health poll.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const reachable = await probeExtractEndpoint(this._options);
    return reachable
      ? { ok: true, detail: HEALTH_DETAILS.proxyReachable }
      : { ok: false, detail: HEALTH_DETAILS.proxyUnavailable };
  }
}
