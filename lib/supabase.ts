import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when the build had no Supabase URL/key (db connector not set up). */
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// createClient THROWS on an empty URL, and this module is imported by the
// lobby, so an unconfigured build used to be a blank white page — including
// the default self-hosted install, which leaves VITE_SUPABASE_URL as a TODO.
// Unconfigured, the client gets a placeholder URL on the reserved .invalid TLD
// (RFC 6761) and a fetch that never touches the network: every query resolves
// at once as an ordinary `{ error }` result, which callers already handle.
//
// The fetch answers 501 rather than throwing on purpose. postgrest-js retries
// a thrown network error (1s + 2s + 4s of backoff), which kept the review setup
// page on "Loading draft…" for ~8 seconds; it does not retry a 501.
const UNCONFIGURED_URL = 'https://supabase-not-configured.invalid';

const notConfiguredFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      code: 'not_configured',
      message: 'Supabase is not configured for this deployment',
    }),
    { status: 501, headers: { 'Content-Type': 'application/json' } },
  );

if (!supabaseConfigured) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set; ' +
      'saved reviews, stats and the tracker are unavailable.',
  );
}

export const supabase = supabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : createClient(UNCONFIGURED_URL, 'not-configured', {
      global: { fetch: notConfiguredFetch },
    });

export type TrackerSession = {
  id: string;
  room_id: string;
  title: string;
  ended_at: string;
  created_at: string;
  participant_count: number;
  model_name: string | null;
  labels: Record<string, string>;
  // Batch BC (docs/plan/14). OPTIONAL, and not because a session may lack them:
  // an install whose database has not re-applied docs/supabase-schema.sql since
  // before batch BC returns rows with no such columns, and the tracker has to
  // render those exactly as it did rather than fail on a missing field.
  /** The design review this meeting was held in, or null for an ad-hoc room. */
  review_id?: string | null;
  /** model_revisions ids that were visible — "what was on screen". */
  revision_ids?: string[] | null;
  // Batch BK (docs/plan/15-sessions-and-variants.md). Optional for the same reason
  // as the two above: an install that has not re-applied docs/supabase-schema.sql
  // returns rows without them, and a meeting with no line is rendered without one
  // rather than dropped — lib/reviews/lines.sessionLabel answers null for it.
  /** review_lines.id this meeting was on, or null for one recorded before lines. */
  line_id?: string | null;
  /** Its number on that line: 3 for "S3", 2 for "A2". */
  seq?: number | null;
};

export type LabelField = {
  id: string;
  name: string;
  position: number;
  values: string[];
  created_at: string;
};

export type TrackerItem = {
  id: string;
  session_id: string;
  type: 'RISK' | 'RATIONALE' | 'ACTION';
  title: string;
  description: string;
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'Open' | 'In Review' | 'Approved' | 'Rejected';
  assignee: string | null;
  due_date: string | null;
  component_reference: string | null;
  department: string | null;
  agent_id: string;
  source_message_ids: string[] | null;
  affected_requirement_ids: string[] | null;
  impact: string | null;
  mitigation_strategy: string | null;
  design_driver: string | null;
  tradeoff_analysis: string | null;
  created_at: string;
  updated_at: string;
  // Batch BC (docs/plan/14). Optional for the same reason TrackerSession's are:
  // a database that predates them returns rows without them, and a card from
  // before them has nothing to point at. Both are rendered, neither is dropped.
  /** The design review this card belongs to, or null for an ad-hoc session. */
  review_id?: string | null;
  /** model_revisions.id this card was raised on, or null when unknown. */
  raised_on_revision?: string | null;
  /** The mesh it was pointed at, when it was pointed at one. */
  part_node_id?: string | null;
  part_name?: string | null;
  /** Who typed a hand-made card. Null for an agent's — agent_id names that one. */
  created_by_name?: string | null;
  /** 'manual' for a card a person typed in the room; 'ai' (or absent) otherwise. */
  source?: 'ai' | 'manual';
  // Batch BK (docs/plan/15-sessions-and-variants.md). Optional like the ones above.
  // line_id and origin_line_id are TWO columns because they come apart: adopting a
  // variant into the main line (batch BL) moves the card's line and leaves its
  // origin alone, which is what lets the tracker say "Raised in Variant A · adopted
  // 12 Oct" instead of quietly rewriting where the risk came from.
  /** review_lines.id the card is on now. */
  line_id?: string | null;
  /** review_lines.id the card was raised on. Never changes. */
  origin_line_id?: string | null;
  /** When the card was adopted into the main line, or null. */
  adopted_at?: string | null;
  /** Why a closed card is closed, when the reason is not one of the four statuses. */
  closed_reason?: string | null;
  // joined
  session?: TrackerSession;
};

export type TrackerComment = {
  id: string;
  item_id: string;
  author_name: string;
  text: string;
  created_at: string;
};

export type StatusHistoryEntry = {
  id: string;
  item_id: string;
  status: string;
  changed_by: string;
  note: string | null;
  created_at: string;
};
