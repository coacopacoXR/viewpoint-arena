// CaptureProvider interface — see docs/plan/02-connector-adapters.md §2.
//
// Every capture implementation (Mock, LocalCapture, Ollama, OpenAI, …)
// implements this interface. A shared contract test suite
// (capture.contract.test.ts) asserts the behavioural guarantees so any
// implementation — ours or a corp's — can be verified against the same checks.

import type { InsightCard, InsightType } from '../../../types';
import type { HealthCheckResult } from '../../health/types.ts';

/**
 * One speaker-labelled slice of a real transcript.
 *
 * From docs/plan/02-connector-adapters.md §2 / local-capture-plan.md
 * §"Provider abstraction". Produced by a TranscriptionProvider (whisper) or
 * supplied by the caller in bring-your-own-transcript mode.
 */
export interface TranscriptChunk {
  speakerId: string;
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Where the review was, spatially, when the transcript window was captured.
 * Fused into the extraction prompt so a card can be attributed to the part
 * that was on screen / under the laser at the time.
 */
export interface SlideContext {
  agendaIdx: number;
  slideTitle: string;
  hoveredPartName?: string;
  laserTargetPartName?: string;
}

/**
 * One row of the flattened component list sent with the capture request.
 * Wire shape of FlatComponent from lib/componentIndex.ts. The model uses `id`
 * as the value for `componentReference` and reads `path` for disambiguation.
 */
export interface ComponentTreeEntry {
  id: string;
  name: string;
  path: string;
}

/**
 * Wire shape of a pointing segment sent with the capture request. Mirrors
 * PointingSegment from lib/pointingTimelineStore.ts but trimmed to the fields
 * the extraction prompt needs: who, what part, when.
 */
export interface PointingSegmentWire {
  userId: string;
  userName: string;
  partId: string;
  partName: string;
  fromMs: number;
  toMs: number;
}

/**
 * One line of the speaker-labelled live transcript sent as a hint. The
 * extraction still runs on Whisper's transcript; this is extra context for
 * attribution, NOT a replacement. A client could lie about it, so nothing
 * security-relevant may depend on it.
 */
export interface TranscriptHintLine {
  speaker: string;
  text: string;
  offsetMs: number;
}

/**
 * The extended context for a grounded capture: the original SlideContext plus
 * the three optional fields section D of the grounded-capture plan adds.
 * All three are JSON-serialised into the multipart form as strings; the
 * capture-service parses them defensively (bad JSON → ignored).
 */
export interface GroundedCaptureContext {
  componentTree?: ComponentTreeEntry[];
  pointingSegments?: PointingSegmentWire[];
  transcriptHint?: TranscriptHintLine[];
}

/**
 * Output of a single dialogue-generation call.
 *
 * Mirrors the shape returned by the original DialogueEngine logic so the
 * MockProvider can be a drop-in extraction with zero behaviour change.
 */
export interface DialogueOutput {
  /** The generated dialogue text (with {poi} already replaced). */
  text: string;
  /** The phrase-library template that was selected. */
  template: {
    type:
      | 'neutral'
      | 'risk'
      | 'rationale'
      | 'action'
      | 'visibility'
      | 'social'
      | 'questioning'
      | 'synthesis';
    summary?: string;
  };
  /** Non-null when the template should trigger an insight card. */
  insightType: InsightType | null;
}

/**
 * CaptureProvider — a capture backend, of any of three flavours.
 *
 * There are three genuinely different kinds of capture provider and they do not
 * share a single method:
 *
 *  1. SIMULATION-driven (`generateDialogue` + `generateInsightDetails`) —
 *     invents a review conversation from the scene tree. This is what
 *     MockProvider does, extracted verbatim from DialogueEngine.tsx. It is
 *     synchronous because nothing leaves the process.
 *  2. TRANSCRIPT-driven (`extractInsights`) — turns a real, already-spoken
 *     meeting transcript into insight cards. This is what the text-in backends
 *     (OpenAI, Anthropic, Ollama) do. It is async because it crosses a network.
 *  3. RECORDING-driven (`captureRecording`) — takes the meeting's AUDIO and
 *     returns insight cards, transcribing internally. This is what
 *     capture-service does, and it is a flavour of its own rather than a
 *     TranscriptCaptureProvider for one concrete reason: the caller has no
 *     transcript to hand over. A provider that accepted `TranscriptChunk[]`
 *     would be promising something capture-service cannot be given, and a
 *     provider that accepted a Blob cannot be handed chunks.
 *
 * No flavour can implement another honestly: a transcript provider has no
 * phrase library to invent dialogue from, the simulation has no transcript to
 * read, and the recording provider has neither until it has transcribed.
 * Making every capability OPTIONAL — and naming each one precisely with
 * SimulationCaptureProvider / TranscriptCaptureProvider /
 * RecordingCaptureProvider below — is what lets one interface cover all three
 * without any side growing a method it would have to stub or throw from.
 *
 * Call sites must feature-detect before use:
 * `typeof provider.extractInsights === 'function'`. An object with none of
 * these capabilities satisfies this type but fails the contract suite, which is
 * where that mistake gets caught.
 */
export interface CaptureProvider {
  /**
   * Generate a single dialogue utterance.
   *
   * @param agentId      Personality profile id ('1' | '2' | '3').
   * @param partName     Name of the part / POI being discussed.
   * @param step         Conversation-context step (drives phase selection).
   * @param isUserDriven Whether the user selected this part (biases depth).
   * @param modelType    Active model type ('bicycle' selects bike-specific phrases).
   */
  generateDialogue?(
    agentId: string,
    partName: string,
    step: number,
    isUserDriven: boolean,
    modelType: string,
  ): DialogueOutput;

  /**
   * Generate structured insight details for an insight card.
   *
   * @param type          Insight type (RISK | RATIONALE | ACTION).
   * @param targetId      POI / component id.
   * @param targetLabel   Human-readable component name.
   * @param decisionState Current decision state for the component.
   * @param template      The phrase template that triggered the insight.
   */
  generateInsightDetails?(
    type: InsightType,
    targetId: string,
    targetLabel: string,
    decisionState: 'NONE' | 'INTERMEDIATE' | 'FINAL',
    template: {
      type: string;
      reasoningChain?: { confidence?: number; implication?: string };
    },
  ): import('../../../types').InsightDetails;

  /**
   * Turn a transcript window plus the spatial context it was spoken in into
   * insight cards. Resolves to `[]` when the window held nothing worth
   * capturing; rejects with a descriptive Error rather than returning
   * partially-built cards.
   *
   * No implementation of this method may accept or return a credential: cloud
   * providers proxy through api/capture/extract.ts, which holds the API key in
   * server-side process.env (docs/plan/02-connector-adapters.md §2).
   */
  extractInsights?(
    transcript: TranscriptChunk[],
    context: SlideContext,
  ): Promise<InsightCard[]>;

  /**
   * Turn a complete meeting RECORDING plus the spatial context it was made in
   * into insight cards. Audio in, cards out: transcription happens inside the
   * backend, so the caller never has to produce a transcript first. Resolves to
   * `[]` when nothing in the recording was worth capturing; rejects with a
   * descriptive Error rather than returning partially-built cards.
   *
   * Batch mode only — one recording, one context, one answer. There is no live
   * partial transcript here, because capture-service has no streaming route
   * (that is T4.7).
   *
   * No implementation of this method may accept or return a credential. The
   * shared secret that guards capture-service is added SERVER-SIDE — by
   * api/capture/local.ts on Vercel, by the `app` container's nginx in the
   * self-hosted stack — so a browser provider posts to a same-origin URL and
   * holds nothing.
   */
  captureRecording?(
    audio: Blob,
    context: SlideContext,
    options?: { signal?: AbortSignal; grounded?: GroundedCaptureContext },
  ): Promise<InsightCard[]>;

  /**
   * Is this connector usable right now? Called by GET /api/health
   * (docs/plan/05-observability-and-metrics.md §1).
   *
   * Optional like the other capabilities, and implemented by every
   * provider in this repo — including MockCaptureProvider, which has nothing
   * to reach and says so. Must never reject, and must never run an extraction:
   * a health check that spends tokens or uploads audio is not a health check.
   * `detail` must stay free of credentials, env var names, model output and
   * hostnames — see the full rules on PLMAdapter.healthCheck in
   * lib/connectors/plm/types.ts.
   */
  healthCheck?(): Promise<HealthCheckResult>;
}

/**
 * The simulation capability, stated precisely. MockCaptureProvider satisfies
 * this (and therefore CaptureProvider) with no change.
 */
export type SimulationCaptureProvider = Required<
  Pick<CaptureProvider, 'generateDialogue' | 'generateInsightDetails'>
>;

/**
 * The transcript capability, stated precisely. OpenAICaptureProvider,
 * AnthropicCaptureProvider and OllamaDirectCaptureProvider all satisfy this.
 *
 * LocalCaptureProvider deliberately does NOT: capture-service takes audio, not
 * a transcript, so it is a RecordingCaptureProvider below. Listing it here
 * would have promised a capability it cannot honour.
 */
export type TranscriptCaptureProvider = Required<
  Pick<CaptureProvider, 'extractInsights'>
>;

/**
 * The recording capability, stated precisely. LocalCaptureProvider (T4.4)
 * satisfies this and nothing else — no phrase library to simulate with, and no
 * transcript to extract from until the service has produced one internally.
 */
export type RecordingCaptureProvider = Required<
  Pick<CaptureProvider, 'captureRecording'>
>;
