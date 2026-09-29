import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import IntegrationsPanel from '../components/UI/IntegrationsPanel';
import AssigneeComboBox from '../components/UI/AssigneeComboBox';
import LabelFieldsSettings from '../components/UI/LabelFieldsSettings';
import LobbyTopBar from '../components/lobby/LobbyTopBar';
import CardContinuityLine, { CardContinuityProvider, CardLineLabel } from '../components/UI/CardContinuity';
import { getDisplayName, useIdentity, AVATAR_COLORS } from '../lib/identity';
import { useLabelFieldsStore } from '../lib/labelFieldsStore';
import { listAllCurations, type CurationSummary } from '../lib/curationsRepo';
import { listModelRevisions, type ModelRevision } from '../lib/reviews/revisionsRepo';
import { listLines } from '../lib/reviews/linesRepo';
import { useSessionMap } from '../lib/reviews/useSessionMap';
import { useReviewRole, isMeetingHostOf } from '../lib/reviews/useReviewRole';
import { activeLines, lineFilterLabel, type ReviewLine } from '../lib/reviews/lines';
import { openLine } from '../lib/reviews/openLine';
import { isClosed } from '../lib/trackerContinuity';
import {
  groupSessions,
  filterSessions,
  collectFieldValues,
  loadGroupByChoice,
  saveGroupByChoice,
  loadGroupFilters,
  saveGroupFilters,
  pruneGroupByChoice,
  UNASSIGNED,
  type GroupByChoice,
  type GroupFilters,
  type GroupNode,
} from '../lib/trackerGrouping';
import type { LabelField } from '../lib/supabase';
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  supabase,
  TrackerSession,
  TrackerItem,
  TrackerComment,
  StatusHistoryEntry,
} from '../lib/supabase';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtShort(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function isOverdue(due: string | null) {
  if (!due) return false;
  return new Date(due) < new Date();
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h) / 0xffffffff;
}

function exportToCSV(items: TrackerItem[], filename = 'viewpoint-tracker') {
  const headers = ['Type', 'Priority', 'Status', 'Title', 'Description', 'Assignee', 'Due Date', 'Component Ref', 'Department', 'Session'];
  const q = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const rows = items.map(i => [
    i.type, i.priority, i.status, q(i.title), q(i.description),
    q(i.assignee ?? ''), i.due_date ?? '', q(i.component_reference ?? ''),
    q(i.department ?? ''), i.session ? fmt(i.session.ended_at) : '',
  ].join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  Object.assign(document.createElement('a'), {
    href: url, download: `${filename}-${new Date().toISOString().split('T')[0]}.csv`,
  }).click();
  URL.revokeObjectURL(url);
}

interface Stats { total: number; openRisks: number; openActions: number; overdue: number; approvedThisWeek: number; }
function computeStats(items: TrackerItem[]): Stats {
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  return {
    total: items.length,
    openRisks: items.filter(i => i.type === 'RISK' && !isClosed(i.status)).length,
    openActions: items.filter(i => i.type === 'ACTION' && !isClosed(i.status)).length,
    overdue: items.filter(i => i.due_date && i.due_date < today && !isClosed(i.status)).length,
    approvedThisWeek: items.filter(i => i.status === 'Approved' && i.updated_at >= weekAgo).length,
  };
}

// ─── Design review continuity (batch BC) ─────────────────────────────────────
// docs/plan/14-rooms-models-admin-ai.md: a design review is the lasting thing,
// a meeting is one dated occurrence inside it, and a card belongs to the review
// and remembers the revision it was raised on. The three helpers below are the
// page's side of that model; the sentences themselves are decided in
// lib/trackerContinuity.ts, which is pure and tested on its own.

/** The filter value for meetings and cards that belong to no design review. */
export const NO_DESIGN_REVIEW = '__no_design_review__';

/**
 * The design review a card belongs to: its own, or the one its meeting was held
 * in.
 *
 * The fallback is not a guess, it is the relationship the schema records — a card
 * is raised in a meeting, and a meeting happens in a review — and it covers the
 * card added by hand through this page's own Add Item modal, which names its
 * session and has never written a review_id of its own. Without it, adding a card
 * to a review's meeting would make that card disappear the moment the review was
 * filtered for.
 */
function reviewOf(item: TrackerItem): string | null {
  return item.review_id ?? item.session?.review_id ?? null;
}

/**
 * The line of a design review a card is on, and the number of the session that
 * raised it (docs/plan/15-sessions-and-variants.md batch BK).
 *
 * The card's own line_id first, then its meeting's: a card added by hand through
 * this page's own Add Item modal names a session and has never written a line of its
 * own, and without the fallback it would vanish the moment the review was filtered
 * by line — the same trap reviewOf's fallback exists for.
 *
 * `origin_line_id` is deliberately NOT what this answers. It is where the card was
 * RAISED, and after a variant is adopted into the main line (batch BL) the two
 * differ: the card belongs to the main line's board and still says it came from
 * Variant A. Filtering by where a card is now is what a reviewer looking at one line
 * wants; the origin is what the label next to it says.
 */
function lineOf(item: TrackerItem): string | null {
  return item.line_id ?? item.session?.line_id ?? null;
}

/**
 * Who a card came from, when that is worth saying.
 *
 * Only a card marked 'manual' gets a line, and the only thing that writes that
 * marker is the meeting flush (lib/trackerBridge.ts) for a card a person typed in
 * the room — batch BG's "+ Card". An agent's card says nothing here because its
 * agent_id is already on the meeting it came from.
 *
 * This page's own Add Item modal does NOT write the marker, and that is deliberate
 * rather than an oversight: the column is new in this batch, and an insert that
 * named it would fail with 42703 on an install whose database has not had
 * docs/supabase-schema.sql re-applied, taking the whole modal with it. So a card
 * added here reads as an agent's — a small untruth on the card rather than a
 * broken tracker. It cannot be fixed by falling back to agent_id either: that
 * modal has always written the literal 'manual' into it, which is a marker and not
 * a name, and rendering it as one would put the word "manual" where a person's
 * name belongs. The honest fix belongs with batch BG, which owns hand-made cards
 * end to end and knows who is signed in.
 */
function cardOrigin(item: TrackerItem): string | null {
  if (item.source !== 'manual') return null;
  const name = item.created_by_name?.trim();
  return name ? `Added by hand · ${name}` : 'Added by hand';
}

// ─── Animated Counter ─────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 700): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let frame = 0;
    const steps = Math.ceil(duration / 16);
    const tick = () => {
      frame++;
      setVal(Math.min(target, Math.round(target * (frame / steps))));
      if (frame < steps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return val;
}

// ─── Seed Demo Data ───────────────────────────────────────────────────────────

async function seedDemoData() {
  const now = Date.now();
  const ago = (d: number) => new Date(now - d * 86400000).toISOString();
  const ahead = (d: number) => new Date(now + d * 86400000).toISOString().split('T')[0];

  const { data: sessions, error } = await supabase.from('tracker_sessions').insert([
    { room_id: 'demo-hmi', title: 'Cockpit HMI Design Review', ended_at: ago(30), participant_count: 4, model_name: 'GPT-4o' },
    { room_id: 'demo-brk', title: 'Brake System Structural Review', ended_at: ago(14), participant_count: 3, model_name: 'GPT-4o' },
    { room_id: 'demo-dash', title: 'Dashboard Assembly Gate Review', ended_at: ago(7), participant_count: 5, model_name: 'claude-opus-4' },
  ]).select();

  if (error || !sessions || sessions.length < 3) { console.error('[seed]', error); return; }
  const [s1, s2, s3] = sessions;

  await supabase.from('tracker_items').insert([
    { session_id: s1.id, type: 'RISK', priority: 'Critical', status: 'Open', title: 'Touch panel latency 180ms under thermal soak — exceeds 150ms REQ-U-305 threshold', description: 'Thermal cycling to 85°C shows latency increase from 95ms baseline to 180ms sustained.', impact: 'Driver may miss critical warning acknowledgment at speed. Non-compliant REQ-U-305.', mitigation_strategy: 'Investigate TCON firmware update; evaluate alternative controller ICs with lower thermal coefficient.', component_reference: 'HMI-TCH-003', agent_id: 'SYS.OP' },
    { session_id: s1.id, type: 'RISK', priority: 'High', status: 'In Review', title: 'HMI backlight contrast ratio 2.8:1 at 80,000 lux — minimum requirement 4.5:1', description: 'Photometric test under direct sunlight simulation shows display unreadable at 90° sun angle.', impact: 'Display unreadable in direct sunlight. Non-compliant REQ-U-201.', mitigation_strategy: 'Evaluate transreflective LCD variants; increase LED current 15% as interim measure.', component_reference: 'HMI-DISP-001', agent_id: 'ENG.UNIT' },
    { session_id: s1.id, type: 'ACTION', priority: 'High', status: 'Open', title: 'Conduct HALT testing on capacitive overlay with 5G RF profile — Band n78, 3.5GHz', description: 'Previous EMC testing did not include 5G bands. Required for 5G-equipped vehicle variants.', assignee: 'ENG.UNIT', due_date: ahead(12), component_reference: 'HMI-TCH-003', agent_id: 'SYS.OP' },
    { session_id: s1.id, type: 'ACTION', priority: 'Medium', status: 'Approved', title: 'Update DWG-HMI-042 — revise bezel tolerance ±0.3mm → ±0.2mm', description: 'Tolerance revision ensures consistent optical bonding adhesive gap across production variance.', assignee: 'DES.LEAD', agent_id: 'DES.LEAD' },
    { session_id: s1.id, type: 'RATIONALE', priority: 'Medium', status: 'Approved', title: 'Resistive touch selected over capacitive — 100% glove-compatible per REQ-U-305', description: 'Technology selection rationale for HMI touch interface.', design_driver: 'REQ-U-305: Primary controls operable by 95th %ile gloved hand.', tradeoff_analysis: 'Resistive: 100% glove-compatible, 2mm resolution, 50k cycle durability. Capacitive: 0.5mm resolution, fails with standard work gloves (12/12 test failures). Selected resistive per safety requirement.', agent_id: 'DES.LEAD' },
    { session_id: s1.id, type: 'RATIONALE', priority: 'Low', status: 'Approved', title: 'Matte surface finish Ra 0.8μm — 78% glare reduction vs gloss at 60° sun incidence', description: 'Display surface treatment for ambient light performance.', design_driver: 'Ambient lighting analysis report L-2026-011.', tradeoff_analysis: 'Matte Ra 0.8μm: sRGB 85%, glare reduction 78%. Gloss: sRGB 95%, 0% reduction. Selected matte.', agent_id: 'ENG.UNIT' },
    { session_id: s2.id, type: 'RISK', priority: 'Critical', status: 'In Review', title: 'Weld joint BRK-MT-07 stress concentration Kt=3.2 at 1.5g lateral — yield margin < 5%', description: 'FEA rev C identifies critical stress riser at fillet transition. Current r=1mm radius insufficient.', impact: 'Structural failure risk during emergency lateral maneuver. Exceeds allowable stress REQ-S-112.', mitigation_strategy: 'Redesign fillet radius r=1mm → r≥4mm. Re-run FEA with revised geometry and updated weld properties.', component_reference: 'BRK-MT-07', department: 'Structures', agent_id: 'SYS.OP' },
    { session_id: s2.id, type: 'RISK', priority: 'High', status: 'Open', title: 'Brake line BRK-LINE-A3 sustained 240°C exposure — exceeds 180°C DOT4 fluid rating', description: 'Thermal survey shows 240°C sustained at line routing position during track duty cycle.', impact: 'Vapor lock risk; brake performance degradation; accelerated fluid degradation.', mitigation_strategy: 'Option A: Reroute via B-pillar tunnel (+280mm). Option B: Add heat shield HX-BRK-02.', component_reference: 'BRK-LINE-A3', agent_id: 'ENG.UNIT' },
    { session_id: s2.id, type: 'ACTION', priority: 'Critical', status: 'Open', title: 'Re-run FEA on BRK-MT-07 with revised weld properties from metallurgy report ML-2026-089', description: 'Current FEA uses generic weld properties. Lab report shows actual yield strength 15% lower than assumed.', assignee: 'SYS.OP', due_date: ahead(7), component_reference: 'BRK-MT-07', agent_id: 'SYS.OP' },
    { session_id: s2.id, type: 'ACTION', priority: 'High', status: 'In Review', title: 'CFD thermal analysis — brake duct Variant B heat rejection at 0.8 m/s airflow', description: 'Variant B duct geometry shows 23% improved flow path. Requires CFD validation before tooling sign-off.', assignee: 'ENG.UNIT', due_date: ahead(17), agent_id: 'ENG.UNIT' },
    { session_id: s2.id, type: 'RATIONALE', priority: 'Medium', status: 'Approved', title: '19mm master cylinder selected — improved pedal feel at cost of 8% higher peak effort', description: 'Master cylinder bore selection based on driver simulator evaluation.', design_driver: 'Driver feedback study SIM-2026-004 (n=8 test drivers).', tradeoff_analysis: '19mm: 85N peak, 0.8mm/bar, 7/8 driver preference. 22mm: 74N peak, 1.1mm/bar, 1/8 preference. Selected 19mm within REQ-U-305.', agent_id: 'DES.LEAD' },
    { session_id: s3.id, type: 'RISK', priority: 'Medium', status: 'Open', title: 'Cluster clip DASH-CLK-09 fatigue life 180k cycles — target 200k, 10% shortfall', description: 'Accelerated vibration testing per IEC 60068-2-64 shows clip fracture at 180k cycles mean.', impact: 'Potential in-field failure at high-vibration duty cycle. Warranty exposure.', mitigation_strategy: 'Option A: Change material PA66-GF30 → PA66-GF50. Option B: Increase cross-section 15%.', component_reference: 'DASH-CLK-09', agent_id: 'ENG.UNIT' },
    { session_id: s3.id, type: 'ACTION', priority: 'High', status: 'Open', title: 'Radiated emissions test — ICU PCB rev R3 to CISPR 25 Class 5', description: 'Rev R3 introduces new power supply topology. Previous approval does not carry forward.', assignee: 'ENG.UNIT', due_date: ahead(25), component_reference: 'DASH-ICU-PCB-R3', agent_id: 'SYS.OP' },
    { session_id: s3.id, type: 'ACTION', priority: 'Medium', status: 'Open', title: 'Source M6×1.0 Grade 12.9 fasteners from approved vendor list — current supplier on Q3 allocation', description: 'Procurement flagged supply risk. Alternative approved source needed to avoid line-stop.', assignee: 'DES.LEAD', due_date: ahead(29), agent_id: 'DES.LEAD' },
    { session_id: s3.id, type: 'RATIONALE', priority: 'High', status: 'Approved', title: 'CAN bus routed via B-pillar cavity — eliminates 3 chafe points at cost of 340mm cable', description: 'Harness routing decision for primary 500 kbps CAN powertrain bus.', design_driver: 'Harness routing conflict matrix HRM-2026-007. Zero chafe tolerance on safety-critical network.', tradeoff_analysis: 'B-pillar: +340mm (+$0.85 BOM), 0 chafe. Direct: 3 chafe points, 3 guards ($1.20 ea). B-pillar saves $2.75 and eliminates failure mode.', agent_id: 'SYS.OP' },
    { session_id: s3.id, type: 'RISK', priority: 'Low', status: 'Open', title: 'Piano black trim DASH-TRIM-PB-01 scratch rate 12% in trial build — target <5%', description: 'Trial assembly (n=50 units) shows cosmetic scratching during panel sub-assembly.', impact: 'Assembly scrap cost ~$180/unit; customer quality perception risk at launch.', mitigation_strategy: 'Evaluate peel-film during sub-assembly; redesign in-station handling fixture.', component_reference: 'DASH-TRIM-PB-01', agent_id: 'DES.LEAD' },
  ]);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STATUSES: TrackerItem['status'][] = ['Open', 'In Review', 'Approved', 'Rejected'];
const ALL_TYPES: TrackerItem['type'][] = ['RISK', 'ACTION', 'RATIONALE'];
const ALL_PRIORITIES: TrackerItem['priority'][] = ['Critical', 'High', 'Medium', 'Low'];

// ─── The app's look (batch BW) ────────────────────────────────────────────────
//
// The user asked for "the aesthetics of the tracker to match the aesthetics of the
// other parts of the app", and the other parts are the lobby and the room's top bar:
// a #f3f4f6 ground, white panels on gray-200 rules, black for the thing that is on,
// mono uppercase labels at 9-10px with tracking, and gray-500 for everything
// secondary. Colour survives ONLY where it means something — RISK red, ACTION blue,
// RATIONALE amber; Approved green, Rejected red, Open and In Review neutral — which
// is the rule batch BJ's Manager view was drawn to. What is gone is the black bar,
// the #111111 sidebar and the white-on-dark rows: they were the last surfaces in the
// app that looked like a different product.

/** One of the top bar's own buttons: the lobby's pill, verbatim. */
const PILL =
  'inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-gray-200 bg-white ' +
  'text-xs font-semibold text-gray-600 hover:border-gray-400 hover:text-black transition-colors';

/** A view chip that is on, and one that is not. The lobby's filter chips, verbatim. */
const CHIP_ON = 'bg-black border-black text-white';
const CHIP_OFF = 'bg-white border-gray-200 text-gray-500 hover:border-gray-400 hover:text-black';

/** Every select on the page, in the house style rather than in a ring of its own. */
const SELECT =
  'border border-gray-200 rounded-md px-2.5 py-1.5 text-xs bg-white text-gray-600 ' +
  'focus:outline-none focus:border-black cursor-pointer hover:border-gray-400 transition-colors';

const priorityBorder: Record<TrackerItem['priority'], string> = {
  Critical: 'border-l-red-500',
  High: 'border-l-orange-400',
  Medium: 'border-l-yellow-400',
  Low: 'border-l-gray-300',
};
const priorityBg: Record<TrackerItem['priority'], string> = {
  Critical: 'bg-red-500 text-white',
  High: 'bg-orange-400 text-white',
  Medium: 'bg-yellow-400 text-gray-900',
  Low: 'bg-gray-200 text-gray-600',
};
const typeColor: Record<TrackerItem['type'], string> = {
  RISK: 'bg-red-100 text-red-700',
  ACTION: 'bg-blue-100 text-blue-700',
  RATIONALE: 'bg-amber-100 text-amber-700',
};
const statusColor: Record<TrackerItem['status'], string> = {
  Open: 'bg-gray-100 text-gray-600',
  'In Review': 'bg-blue-100 text-blue-700',
  Approved: 'bg-emerald-100 text-emerald-700',
  Rejected: 'bg-red-100 text-red-600',
};
const statusDot: Record<TrackerItem['status'], string> = {
  Open: 'bg-gray-400',
  'In Review': 'bg-blue-500',
  Approved: 'bg-emerald-500',
  Rejected: 'bg-red-500',
};
const riskMatrixColor: Record<TrackerItem['priority'], string> = {
  Critical: '#ef4444',
  High: '#f97316',
  Medium: '#eab308',
  Low: '#6b7280',
};
// Zone positions for risk matrix (cx, cy in 0-1 space, origin bottom-left)
const riskZone: Record<TrackerItem['priority'], [number, number]> = {
  Critical: [0.78, 0.82],
  High: [0.58, 0.60],
  Medium: [0.35, 0.38],
  Low: [0.15, 0.18],
};

// ─── Badges ───────────────────────────────────────────────────────────────────

const TypeBadge: React.FC<{ type: TrackerItem['type'] }> = ({ type }) => (
  <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tracking-widest', typeColor[type])}>
    {type}
  </span>
);
const PriorityBadge: React.FC<{ priority: TrackerItem['priority'] }> = ({ priority }) => (
  <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold', priorityBg[priority])}>
    {priority.toUpperCase()}
  </span>
);
const StatusBadge: React.FC<{ status: TrackerItem['status'] }> = ({ status }) => (
  <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', statusColor[status])}>
    <span className={clsx('w-1.5 h-1.5 rounded-full', statusDot[status])} />
    {status}
  </span>
);

// ─── Stats Bar ────────────────────────────────────────────────────────────────

const StatTile: React.FC<{ label: string; value: number; urgent?: boolean; accent: string }> = ({ label, value, urgent, accent }) => {
  const displayed = useCountUp(value);
  return (
    <div className={clsx('flex-1 min-w-[100px] rounded-lg px-4 py-3 flex flex-col gap-0.5 border transition-all', accent, urgent && value > 0 && 'ring-1 ring-offset-1 ring-red-300')}>
      <span className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{displayed}</span>
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{label}</span>
    </div>
  );
};

const StatsBar: React.FC<{ stats: Stats }> = ({ stats }) => (
  <div className="flex-shrink-0 flex gap-3 px-6 py-3 bg-white border-b border-gray-200 overflow-x-auto">
    <StatTile label="Total Items" value={stats.total} accent="bg-white border-gray-200" />
    <StatTile label="Open Risks" value={stats.openRisks} urgent accent={stats.openRisks > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'} />
    <StatTile label="Pending Actions" value={stats.openActions} accent={stats.openActions > 0 ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'} />
    <StatTile label="Overdue" value={stats.overdue} urgent accent={stats.overdue > 0 ? 'bg-orange-50 border-orange-200' : 'bg-white border-gray-200'} />
    <StatTile label="Approved / Week" value={stats.approvedThisWeek} accent="bg-emerald-50 border-emerald-200" />
  </div>
);

// ─── Inline Field ─────────────────────────────────────────────────────────────

interface InlineFieldProps {
  label: string;
  value: string | null;
  onSave: (val: string | null) => Promise<void>;
  type?: 'text' | 'textarea' | 'date' | 'select';
  options?: string[];
  placeholder?: string;
  mono?: boolean;
}

const InlineField: React.FC<InlineFieldProps> = ({ label, value, onSave, type = 'text', options, placeholder = 'Click to edit…', mono }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  async function commit() {
    const next = draft.trim() || null;
    if (next === (value ?? null)) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(next); } catch { setDraft(value ?? ''); }
    setSaving(false);
    setEditing(false);
  }

  const ring = 'border border-blue-400 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-blue-50/30 w-full';

  return (
    <div className="group/f">
      {label && <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">{label}</p>}
      {editing ? (
        type === 'textarea' ? (
          <textarea ref={ref as React.RefObject<HTMLTextAreaElement>} value={draft}
            onChange={e => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); } if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit(); }}
            className={clsx(ring, 'resize-none min-h-[80px]', mono && 'font-mono text-xs')} rows={4} />
        ) : type === 'select' && options ? (
          <select autoFocus value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} className={clsx(ring, 'cursor-pointer')}>
            <option value="">— unset —</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input ref={ref as React.RefObject<HTMLInputElement>} type={type === 'date' ? 'date' : 'text'}
            value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); } }}
            className={clsx(ring, mono && 'font-mono text-xs')} />
        )
      ) : (
        <div onClick={() => setEditing(true)}
          className={clsx('cursor-text rounded-lg px-2.5 py-1.5 min-h-[34px] flex items-start justify-between gap-2 transition-colors group-hover/f:bg-gray-50 hover:ring-1 hover:ring-gray-200', saving && 'opacity-40 pointer-events-none')}>
          <span className={clsx('text-sm flex-1 leading-relaxed', mono ? 'font-mono text-xs' : '', value ? 'text-gray-800' : 'text-gray-300 italic text-xs')}>
            {value ?? placeholder}
          </span>
          <span className="opacity-0 group-hover/f:opacity-100 text-gray-300 text-xs flex-shrink-0 mt-0.5">✎</span>
        </div>
      )}
    </div>
  );
};

// ─── Board Card ───────────────────────────────────────────────────────────────

interface CardProps { item: TrackerItem; onClick: () => void; isDragging?: boolean; index?: number; }

const CardContent: React.FC<{ item: TrackerItem; isDragging?: boolean }> = ({ item, isDragging }) => {
  const overdue = isOverdue(item.due_date);
  const origin = cardOrigin(item);
  return (
    <div className={clsx(
      'bg-white rounded-lg border-l-4 border border-gray-200 p-3.5 space-y-2.5 group select-none',
      priorityBorder[item.priority],
      isDragging ? 'shadow-2xl ring-2 ring-blue-400 ring-offset-1 opacity-95 rotate-1 scale-105' : 'shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-gray-400',
      'transition-all duration-150'
    )}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <TypeBadge type={item.type} />
        <PriorityBadge priority={item.priority} />
        {/* Which run of meetings this belongs to, beside the revision continuity
            below it: the line says where, the revision says which version of the
            product. Renders nothing for a card with no line. */}
        <CardLineLabel item={item} />
        {origin && (
          <span title={origin} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-500">
            ✍ {item.created_by_name?.trim() || 'by hand'}
          </span>
        )}
      </div>
      <p className="text-sm font-semibold text-gray-900 leading-snug line-clamp-2">{item.title}</p>
      {item.description && <p className="text-[11px] text-gray-400 leading-snug line-clamp-1">{item.description}</p>}
      {item.component_reference && (
        <p className="font-mono text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded w-fit border border-gray-100">{item.component_reference}</p>
      )}
      <CardContinuityLine item={item} />
      <div className="flex items-center justify-between pt-1 border-t border-gray-100">
        <span className="font-mono text-[10px] text-gray-400">{item.assignee ?? '—'}</span>
        {item.due_date && (
          <span className={clsx('font-mono text-[10px]', overdue ? 'text-red-500 font-bold' : 'text-gray-400')}>
            {fmtShort(item.due_date)}{overdue ? ' ⚠' : ''}
          </span>
        )}
      </div>
    </div>
  );
};

const SortableCard: React.FC<CardProps> = ({ item, onClick, index = 0 }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    animationDelay: `${index * 40}ms`,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className="cursor-pointer animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <CardContent item={item} isDragging={isDragging} />
    </div>
  );
};

// ─── Board View ───────────────────────────────────────────────────────────────

interface BoardViewProps {
  items: TrackerItem[];
  onItemClick: (i: TrackerItem) => void;
  onStatusChange: (id: string, status: TrackerItem['status']) => Promise<void>;
  onAddItem: (status: TrackerItem['status']) => void;
}

const BoardView: React.FC<BoardViewProps> = ({ items, onItemClick, onStatusChange, onAddItem }) => {
  const [activeItem, setActiveItem] = useState<TrackerItem | null>(null);
  const [localItems, setLocalItems] = useState(items);

  useEffect(() => { setLocalItems(items); }, [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function onDragStart(e: DragStartEvent) {
    setActiveItem(localItems.find(i => i.id === e.active.id) ?? null);
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const overId = over.id as string;
    const isColumn = ALL_STATUSES.includes(overId as TrackerItem['status']);
    if (!isColumn) return;
    const newStatus = overId as TrackerItem['status'];
    setLocalItems(prev => prev.map(i => i.id === active.id ? { ...i, status: newStatus } : i));
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveItem(null);
    if (!over) return;
    const overId = over.id as string;
    const isColumn = ALL_STATUSES.includes(overId as TrackerItem['status']);
    const targetStatus = isColumn ? (overId as TrackerItem['status']) : localItems.find(i => i.id === overId)?.status;
    if (!targetStatus) return;
    const movedItem = localItems.find(i => i.id === active.id);
    if (!movedItem || movedItem.status === targetStatus) return;
    await onStatusChange(active.id as string, targetStatus);
  }

  const colItems = (status: TrackerItem['status']) => localItems.filter(i => i.status === status);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      <div className="flex gap-4 h-full overflow-x-auto pb-4">
        {ALL_STATUSES.map(status => (
          <DroppableColumn key={status} status={status} items={colItems(status)} onItemClick={onItemClick} onAddItem={onAddItem} />
        ))}
      </div>
      <DragOverlay>
        {activeItem && <CardContent item={activeItem} isDragging />}
      </DragOverlay>
    </DndContext>
  );
};

const DroppableColumn: React.FC<{ status: TrackerItem['status']; items: TrackerItem[]; onItemClick: (i: TrackerItem) => void; onAddItem: (status: TrackerItem['status']) => void }> = ({ status, items, onItemClick, onAddItem }) => {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const colHeader: Record<TrackerItem['status'], string> = {
    Open: 'text-gray-600',
    'In Review': 'text-blue-600',
    Approved: 'text-emerald-600',
    Rejected: 'text-red-500',
  };
  return (
    <div className="flex-shrink-0 w-[240px] flex flex-col">
      <div className="flex items-center gap-2 mb-3 px-0.5">
        <span className={clsx('text-xs font-bold uppercase tracking-wide', colHeader[status])}>{status}</span>
        <span className="text-xs font-mono text-gray-500 ml-auto bg-white border border-gray-200 px-1.5 py-0.5 rounded-full">{items.length}</span>
      </div>
      <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy} id={status}>
        <div
          ref={setNodeRef}
          className={clsx(
            'flex-1 overflow-y-auto space-y-2 min-h-[120px] rounded-lg p-2 transition-all duration-150',
            isOver ? 'bg-blue-50 ring-2 ring-blue-200 ring-offset-1' : ''
          )}
        >
          {items.length === 0 ? (
            <div className={clsx('border-2 border-dashed rounded-lg h-24 flex items-center justify-center text-[11px] font-mono transition-colors', isOver ? 'border-blue-300 text-blue-400 bg-blue-50/50' : 'border-gray-300 text-gray-400')}>
              drop here
            </div>
          ) : items.map((item, idx) => (
            <SortableCard key={item.id} item={item} onClick={() => onItemClick(item)} index={idx} />
          ))}
        </div>
      </SortableContext>
      <button
        onClick={() => onAddItem(status)}
        className="mt-2 text-[11px] font-mono text-gray-400 hover:text-black text-left px-2 py-1.5 rounded-md hover:bg-gray-100 transition-colors flex items-center gap-1"
      >
        <span className="text-base leading-none">+</span> Add item
      </button>
    </div>
  );
};

// ─── Risk Matrix ──────────────────────────────────────────────────────────────

interface RiskMatrixProps { items: TrackerItem[]; onItemClick: (i: TrackerItem) => void; }

const RiskMatrix: React.FC<RiskMatrixProps> = ({ items, onItemClick }) => {
  const risks = items.filter(i => i.type === 'RISK');
  const [hovered, setHovered] = useState<string | null>(null);
  const W = 520; const H = 400; const PAD = 48;
  const innerW = W - PAD * 2; const innerH = H - PAD * 2;

  function itemToXY(item: TrackerItem): [number, number] {
    const [bx, by] = riskZone[item.priority];
    const jitter = hashId(item.id);
    const jitter2 = hashId(item.id + 'y');
    const spread = 0.08;
    const x = PAD + (bx + (jitter - 0.5) * spread) * innerW;
    const y = PAD + (1 - (by + (jitter2 - 0.5) * spread)) * innerH;
    return [x, y];
  }

  const zones = [
    { x: 0, y: 0, w: 0.5, h: 0.5, color: '#f0fdf4', label: '' },
    { x: 0.5, y: 0, w: 0.5, h: 0.5, color: '#fefce8', label: '' },
    { x: 0, y: 0.5, w: 0.5, h: 0.5, color: '#fefce8', label: '' },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5, color: '#fef2f2', label: '' },
  ];

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex gap-6 p-6 flex-wrap items-start">
        <div className="flex-shrink-0">
          <p className="text-xs font-mono font-bold text-gray-400 uppercase tracking-widest mb-3">Risk Matrix — {risks.length} risks</p>
          <div className="relative" style={{ width: W, height: H }}>
            <svg width={W} height={H} className="absolute inset-0">
              {/* Background zones */}
              {zones.map((z, i) => (
                <rect key={i}
                  x={PAD + z.x * innerW} y={PAD + (1 - z.y - z.h) * innerH}
                  width={z.w * innerW} height={z.h * innerH}
                  fill={z.color} stroke="#e5e7eb" strokeWidth={1} />
              ))}
              {/* Grid lines */}
              {[0.25, 0.5, 0.75].map(t => (
                <React.Fragment key={t}>
                  <line x1={PAD + t * innerW} y1={PAD} x2={PAD + t * innerW} y2={PAD + innerH} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 4" />
                  <line x1={PAD} y1={PAD + t * innerH} x2={PAD + innerW} y2={PAD + t * innerH} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 4" />
                </React.Fragment>
              ))}
              {/* Axes */}
              <line x1={PAD} y1={PAD} x2={PAD} y2={PAD + innerH} stroke="#9ca3af" strokeWidth={1.5} />
              <line x1={PAD} y1={PAD + innerH} x2={PAD + innerW} y2={PAD + innerH} stroke="#9ca3af" strokeWidth={1.5} />
              {/* Axis labels */}
              <text x={PAD + innerW / 2} y={H - 8} textAnchor="middle" fill="#6b7280" fontSize={11} fontFamily="monospace" fontWeight="600">PROBABILITY →</text>
              <text x={14} y={PAD + innerH / 2} textAnchor="middle" fill="#6b7280" fontSize={11} fontFamily="monospace" fontWeight="600" transform={`rotate(-90, 14, ${PAD + innerH / 2})`}>IMPACT →</text>
              {/* Zone labels. The 300-shade greens and reds these were read on a dark
                  page; on the pale zone fills they are decoration rather than a word,
                  so they take the 600 shade of the same two meanings. */}
              <text x={PAD + 0.25 * innerW} y={PAD + 0.97 * innerH} textAnchor="middle" fill="#16a34a" fontSize={9} fontFamily="monospace" fontWeight="600">LOW</text>
              <text x={PAD + 0.75 * innerW} y={PAD + 0.03 * innerH + 10} textAnchor="middle" fill="#dc2626" fontSize={9} fontFamily="monospace" fontWeight="600">CRITICAL ZONE</text>
              {/* Risk dots */}
              {risks.map(item => {
                const [x, y] = itemToXY(item);
                const isHov = hovered === item.id;
                return (
                  <g key={item.id} style={{ cursor: 'pointer' }}
                    onClick={() => onItemClick(item)}
                    onMouseEnter={() => setHovered(item.id)}
                    onMouseLeave={() => setHovered(null)}>
                    <circle cx={x} cy={y} r={isHov ? 12 : 9} fill={riskMatrixColor[item.priority]} opacity={isHov ? 1 : 0.85}
                      style={{ transition: 'r 0.15s, opacity 0.15s' }} />
                    <circle cx={x} cy={y} r={isHov ? 12 : 9} fill="none" stroke="white" strokeWidth={1.5} />
                    {isHov && (
                      <foreignObject x={x + 14} y={y - 30} width={200} height={80} style={{ overflow: 'visible' }}>
                        <div style={{ background: '#111', color: '#fff', borderRadius: 8, padding: '6px 10px', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.4, pointerEvents: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.3)', maxWidth: 200 }}>
                          <div style={{ fontWeight: 700, marginBottom: 2, color: riskMatrixColor[item.priority] }}>{item.priority}</div>
                          <div style={{ wordBreak: 'break-word' }}>{item.title.slice(0, 80)}{item.title.length > 80 ? '…' : ''}</div>
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Legend + risk list */}
        <div className="flex-1 min-w-[220px] space-y-4 pt-8">
          <div className="space-y-2">
            <p className="text-[9px] font-mono font-bold text-gray-400 uppercase tracking-widest">Priority Legend</p>
            {ALL_PRIORITIES.map(p => (
              <div key={p} className="flex items-center gap-2 text-xs">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: riskMatrixColor[p] }} />
                <span className="font-mono text-gray-600">{p}</span>
                <span className="text-gray-400 ml-auto">{risks.filter(i => i.priority === p).length}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-gray-100 pt-3 space-y-1.5">
            <p className="text-[9px] font-mono font-bold text-gray-400 uppercase tracking-widest mb-2">All Risks</p>
            {risks.length === 0
              ? <p className="text-xs text-gray-400 font-mono italic">No risks in current view.</p>
              : risks.map(item => (
                <button key={item.id} onClick={() => onItemClick(item)}
                  className="w-full text-left flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 transition-colors group/r">
                  <span className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5" style={{ background: riskMatrixColor[item.priority] }} />
                  <span className="text-xs text-gray-700 leading-snug line-clamp-2 group-hover/r:text-gray-900">{item.title}</span>
                </button>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── List View ────────────────────────────────────────────────────────────────

type SortKey = 'type' | 'priority' | 'title' | 'assignee' | 'due_date' | 'status' | 'session' | 'updated_at';

const ListView: React.FC<{ items: TrackerItem[]; onItemClick: (i: TrackerItem) => void }> = ({ items, onItemClick }) => {
  const [sortKey, setSortKey] = useState<SortKey>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function handleSort(k: SortKey) {
    setSortKey(k); setSortDir(prev => sortKey === k ? (prev === 'asc' ? 'desc' : 'asc') : 'asc');
  }

  const sorted = [...items].sort((a, b) => {
    if (sortKey === 'priority') {
      const o = { Critical: 0, High: 1, Medium: 2, Low: 3 };
      return sortDir === 'asc' ? o[a.priority] - o[b.priority] : o[b.priority] - o[a.priority];
    }
    const av = sortKey === 'session' ? (a.session?.ended_at ?? a.created_at) : (a[sortKey] as string) ?? '';
    const bv = sortKey === 'session' ? (b.session?.ended_at ?? b.created_at) : (b[sortKey] as string) ?? '';
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const Th: React.FC<{ col: SortKey; label: string; cls?: string }> = ({ col, label, cls }) => (
    <th onClick={() => handleSort(col)} className={clsx('px-3 py-2.5 text-left text-[10px] font-mono font-bold text-gray-400 uppercase tracking-widest cursor-pointer select-none whitespace-nowrap hover:text-gray-700 transition-colors', cls)}>
      {label}{sortKey === col && <span className="ml-1 opacity-50">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );

  return (
    <div className="overflow-auto h-full rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 bg-white border-b border-gray-100 z-10">
          <tr>
            <Th col="type" label="Type" />
            <Th col="priority" label="Priority" />
            <Th col="title" label="Title" cls="min-w-[260px]" />
            <Th col="assignee" label="Assignee" />
            <Th col="due_date" label="Due" />
            <Th col="status" label="Status" />
            <Th col="session" label="Session" />
            <Th col="updated_at" label="Updated" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((item, idx) => (
            <tr key={item.id} onClick={() => onItemClick(item)}
              className={clsx('border-b border-gray-50 cursor-pointer hover:bg-blue-50/30 transition-colors border-l-4', priorityBorder[item.priority], idx % 2 === 1 ? 'bg-gray-50/30' : '')}>
              <td className="px-3 py-2.5"><TypeBadge type={item.type} /></td>
              <td className="px-3 py-2.5"><PriorityBadge priority={item.priority} /></td>
              <td className="px-3 py-2.5 max-w-xs">
                <span className="font-medium text-gray-900 line-clamp-1">{item.title}</span>
                {item.component_reference && <span className="font-mono text-[10px] text-gray-400 ml-2">{item.component_reference}</span>}
                <CardLineLabel item={item} className="inline-flex items-center ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-500 align-middle" />
                <CardContinuityLine item={item} className="font-mono text-[10px] text-gray-500 mt-0.5" />
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{item.assignee ?? '—'}</td>
              <td className={clsx('px-3 py-2.5 font-mono text-xs whitespace-nowrap', isOverdue(item.due_date) ? 'text-red-500 font-bold' : 'text-gray-400')}>
                {item.due_date ? fmtShort(item.due_date) : '—'}{isOverdue(item.due_date) ? ' ⚠' : ''}
              </td>
              <td className="px-3 py-2.5"><StatusBadge status={item.status} /></td>
              <td className="px-3 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">{item.session ? fmtShort(item.session.ended_at) : '—'}</td>
              <td className="px-3 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">{fmtShort(item.updated_at)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={8} className="px-3 py-16 text-center text-sm text-gray-400 font-mono">No items match the current filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

// ─── Command Palette ──────────────────────────────────────────────────────────

interface CommandPaletteProps {
  items: TrackerItem[];
  sessions: TrackerSession[];
  onItemClick: (i: TrackerItem) => void;
  onClose: () => void;
}

const CommandPalette: React.FC<CommandPaletteProps> = ({ items, onItemClick, onClose }) => {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    if (!q.trim()) return items.slice(0, 8);
    const lq = q.toLowerCase();
    return items.filter(i =>
      i.title.toLowerCase().includes(lq) ||
      (i.description ?? '').toLowerCase().includes(lq) ||
      (i.assignee ?? '').toLowerCase().includes(lq) ||
      (i.component_reference ?? '').toLowerCase().includes(lq) ||
      i.type.toLowerCase().includes(lq) ||
      i.priority.toLowerCase().includes(lq)
    ).slice(0, 10);
  }, [q, items]);

  useEffect(() => { setCursor(0); }, [results]);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && results[cursor]) { onItemClick(results[cursor]); onClose(); }
    else if (e.key === 'Escape') onClose();
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed left-1/2 top-[20%] -translate-x-1/2 z-50 w-[560px] bg-white rounded-lg shadow-2xl overflow-hidden border border-gray-200 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <span className="text-gray-400 text-sm" aria-hidden="true">🔍</span>
          <input ref={inputRef} type="text" value={q} onChange={e => setQ(e.target.value)} onKeyDown={handleKey}
            placeholder="Search items, assignees, components…"
            className="flex-1 text-sm text-gray-900 focus:outline-none placeholder:text-gray-300" />
          <kbd className="font-mono text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded border border-gray-200">ESC</kbd>
        </div>
        <div className="max-h-[400px] overflow-y-auto">
          {results.length === 0 ? (
            <p className="text-sm text-gray-400 font-mono text-center py-10">No results</p>
          ) : (
            <div className="p-2">
              {!q.trim() && <p className="font-mono text-[9px] font-bold text-gray-300 uppercase tracking-widest px-3 py-1.5">Recent items</p>}
              {results.map((item, i) => (
                <button key={item.id} onClick={() => { onItemClick(item); onClose(); }} onMouseEnter={() => setCursor(i)}
                  className={clsx('w-full flex items-start gap-3 px-3 py-2.5 rounded-md text-left transition-colors', i === cursor ? 'bg-black text-white' : 'hover:bg-gray-50')}>
                  <div className="flex gap-1 flex-shrink-0 pt-0.5">
                    <span className={clsx('text-[10px] font-bold font-mono px-1.5 py-0.5 rounded', i === cursor ? 'bg-white/20 text-white' : typeColor[item.type])}>{item.type}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={clsx('text-sm font-medium line-clamp-1', i === cursor ? 'text-white' : 'text-gray-900')}>{item.title}</p>
                    <div className={clsx('flex items-center gap-2 mt-0.5', i === cursor ? 'text-gray-300' : 'text-gray-400')}>
                      <span className="font-mono text-[10px]">{item.priority}</span>
                      {item.assignee && <span className="font-mono text-[10px]">· {item.assignee}</span>}
                      {item.component_reference && <span className="font-mono text-[10px]">· {item.component_reference}</span>}
                    </div>
                  </div>
                  <StatusBadge status={item.status} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-4">
          <span className="font-mono text-[10px] text-gray-300">↑↓ navigate</span>
          <span className="font-mono text-[10px] text-gray-300">↵ open</span>
          <span className="font-mono text-[10px] text-gray-300 ml-auto">{items.length} total items</span>
        </div>
      </div>
    </>
  );
};

// ─── Item Drawer ──────────────────────────────────────────────────────────────

type DrawerTab = 'details' | 'comments' | 'history';

interface ItemDrawerProps {
  item: TrackerItem;
  onClose: () => void;
  onUpdate: (id: string, updates: Partial<TrackerItem>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const ItemDrawer: React.FC<ItemDrawerProps> = ({ item, onClose, onUpdate, onDelete }) => {
  const [tab, setTab] = useState<DrawerTab>('details');
  const [comments, setComments] = useState<TrackerComment[]>([]);
  const [history, setHistory] = useState<StatusHistoryEntry[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchComments = useCallback(async () => {
    setLoadingComments(true);
    const { data } = await supabase.from('tracker_comments').select('*').eq('item_id', item.id).order('created_at');
    setComments((data as TrackerComment[]) ?? []);
    setLoadingComments(false);
  }, [item.id]);

  const fetchHistory = useCallback(async () => {
    setLoadingHistory(true);
    const { data } = await supabase.from('tracker_status_history').select('*').eq('item_id', item.id).order('created_at', { ascending: false });
    setHistory((data as StatusHistoryEntry[]) ?? []);
    setLoadingHistory(false);
  }, [item.id]);

  useEffect(() => { fetchComments(); }, [fetchComments]);
  useEffect(() => { if (tab === 'history') fetchHistory(); }, [tab, fetchHistory]);

  async function handleAddComment() {
    const text = newComment.trim(); if (!text) return;
    setSubmitting(true);
    await supabase.from('tracker_comments').insert({ item_id: item.id, author_name: getDisplayName(), text });
    setNewComment(''); await fetchComments(); setSubmitting(false);
  }

  function field(key: keyof TrackerItem) {
    return async (val: string | null) => { await onUpdate(item.id, { [key]: val } as Partial<TrackerItem>); };
  }

  const Tab: React.FC<{ id: DrawerTab; label: string; count?: number }> = ({ id, label, count }) => (
    <button onClick={() => setTab(id)} className={clsx('px-3 py-2 text-xs font-semibold transition-colors border-b-2 -mb-px', tab === id ? 'border-black text-black' : 'border-transparent text-gray-400 hover:text-gray-700')}>
      {label}{count !== undefined && count > 0 && <span className="ml-1.5 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full text-[10px]">{count}</span>}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/20 backdrop-blur-[2px] z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-screen w-full lg:w-[520px] bg-white z-50 flex flex-col shadow-2xl border-l border-gray-200 animate-in slide-in-from-right duration-200">
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2 flex-wrap pt-0.5">
            <TypeBadge type={item.type} />
            <PriorityBadge priority={item.priority} />
            {item.component_reference && <span className="font-mono text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded border border-gray-200">{item.component_reference}</span>}
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-700 transition-colors text-xl leading-none ml-4 flex-shrink-0">✕</button>
        </div>
        <div className="px-6 pt-4 pb-2 border-b border-gray-100 flex-shrink-0">
          <InlineField label="" value={item.title} onSave={field('title')} placeholder="Item title…" />
          {/* Where this card came from, above the revisions it has lived through:
              "Variant A · A2" and then "Raised on Rev A · still open on Rev C". */}
          <CardLineLabel item={item} className="inline-flex items-center mx-2.5 mb-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-500" />
          <CardContinuityLine item={item} className="font-mono text-[11px] text-gray-500 px-2.5 pb-1" />
          {cardOrigin(item) && <p className="font-mono text-[10px] text-gray-400 px-2.5 pb-1">{cardOrigin(item)}</p>}
        </div>
        <div className="flex gap-0 px-6 border-b border-gray-100 flex-shrink-0">
          <Tab id="details" label="Details" />
          <Tab id="comments" label="Comments" count={comments.length} />
          <Tab id="history" label="History" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {tab === 'details' && (
            <div className="px-6 py-5 space-y-5">
              <div>
                <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-2">Status</p>
                <div className="flex gap-2 flex-wrap">
                  {ALL_STATUSES.map(s => (
                    <button key={s} onClick={() => onUpdate(item.id, { status: s })}
                      className={clsx('px-3 py-1.5 rounded-full text-xs font-semibold border transition-all', item.status === s ? statusColor[s] + ' border-transparent shadow-sm' : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-700')}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <InlineField label="Description" value={item.description} onSave={field('description')} type="textarea" placeholder="Add a description…" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                <div>
                  <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">ASSIGNEE</p>
                  <AssigneeComboBox
                    value={item.assignee ?? ''}
                    onChange={(v) => { field('assignee')(v || null); }}
                  />
                </div>
                <InlineField label="Due Date" value={item.due_date} onSave={field('due_date')} type="date" />
                <InlineField label="Priority" value={item.priority} onSave={field('priority')} type="select" options={[...ALL_PRIORITIES]} />
                <InlineField label="Department" value={item.department} onSave={field('department')} placeholder="—" />
                <div className="col-span-2">
                  <InlineField label="Component Reference" value={item.component_reference} onSave={field('component_reference')} mono />
                </div>
              </div>
              {item.type === 'RISK' && (
                <div className="space-y-4 border-t border-gray-100 pt-4">
                  <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Risk Fields</p>
                  <InlineField label="Impact" value={item.impact} onSave={field('impact')} type="textarea" placeholder="Describe the potential impact…" />
                  <InlineField label="Mitigation Strategy" value={item.mitigation_strategy} onSave={field('mitigation_strategy')} type="textarea" placeholder="Describe the mitigation approach…" />
                </div>
              )}
              {item.type === 'RATIONALE' && (
                <div className="space-y-4 border-t border-gray-100 pt-4">
                  <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Rationale Fields</p>
                  <InlineField label="Design Driver" value={item.design_driver} onSave={field('design_driver')} type="textarea" placeholder="What drove this decision?" />
                  <InlineField label="Tradeoff Analysis" value={item.tradeoff_analysis} onSave={field('tradeoff_analysis')} type="textarea" placeholder="What alternatives were considered?" />
                </div>
              )}
              {item.session && (
                <div className="border-t border-gray-100 pt-4">
                  <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-2">Source Session</p>
                  <div className="bg-gray-50 rounded-lg border border-gray-200 px-3 py-2.5">
                    <p className="text-sm font-semibold text-gray-800">{item.session.title}</p>
                    <p className="font-mono text-xs text-gray-400 mt-0.5">{fmt(item.session.ended_at)} · {item.session.participant_count} participants{item.session.model_name ? ` · ${item.session.model_name}` : ''}</p>
                  </div>
                </div>
              )}
            </div>
          )}
          {tab === 'comments' && (
            <div className="px-6 py-5 space-y-4">
              {loadingComments ? <p className="text-xs text-gray-400 font-mono animate-pulse">Loading…</p>
                : comments.length === 0 ? <p className="text-sm text-gray-400 text-center py-8 italic">No comments yet.</p>
                : (
                  <div className="space-y-4">
                    {comments.map(c => (
                      <div key={c.id} className="flex gap-3">
                        <div className="w-7 h-7 rounded-full bg-black text-white flex items-center justify-center text-xs font-bold flex-shrink-0">{c.author_name[0].toUpperCase()}</div>
                        <div className="flex-1">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-sm font-semibold text-gray-900">{c.author_name}</span>
                            <span className="font-mono text-[10px] text-gray-400">{fmt(c.created_at)} · {fmtTime(c.created_at)}</span>
                          </div>
                          <p className="text-sm text-gray-700 leading-relaxed">{c.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <input type="text" value={newComment} onChange={e => setNewComment(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddComment(); } }}
                  placeholder="Add a comment…" disabled={submitting}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black placeholder:text-gray-300" />
                <button onClick={handleAddComment} disabled={submitting || !newComment.trim()}
                  className="px-4 py-2 bg-black text-white text-xs font-semibold rounded-lg hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Post</button>
              </div>
            </div>
          )}
          {tab === 'history' && (
            <div className="px-6 py-5">
              {loadingHistory ? <p className="text-xs text-gray-400 font-mono animate-pulse">Loading…</p>
                : history.length === 0 ? <p className="text-sm text-gray-400 text-center py-8 italic">No status changes recorded.</p>
                : (
                  <div className="relative">
                    <div className="absolute left-3 top-2 bottom-2 w-px bg-gray-100" />
                    <div className="space-y-4">
                      {history.map(h => (
                        <div key={h.id} className="flex gap-4">
                          <div className={clsx('w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center z-10 border-2 border-white shadow-sm', statusDot[h.status as TrackerItem['status']] ?? 'bg-gray-400')} />
                          <div className="flex-1 pb-1">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={h.status as TrackerItem['status']} />
                              <span className="text-xs text-gray-500">by <span className="font-semibold">{h.changed_by}</span></span>
                            </div>
                            <p className="font-mono text-[10px] text-gray-400 mt-1">{fmt(h.created_at)} · {fmtTime(h.created_at)}</p>
                            {h.note && <p className="text-xs text-gray-600 mt-1 italic">{h.note}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 px-6 py-3 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={async () => { if (confirm('Delete this item permanently?')) { await onDelete(item.id); onClose(); } }}
            className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors flex items-center gap-1"
          >🗑 Delete item</button>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-gray-300">Updated {fmtShort(item.updated_at)}</span>
            <button onClick={() => exportToCSV([item], `item-${item.id.slice(0, 8)}`)} className="text-xs font-medium text-gray-400 hover:text-gray-800 transition-colors">↓ Export</button>
          </div>
        </div>
      </div>
    </>
  );
};

// ─── Grouped Sidebar Nodes ───────────────────────────────────────────────────

const GroupedSidebarNodes: React.FC<{
  nodes: GroupNode[];
  allItems: TrackerItem[];
  selectedSessionId: string | null;
  onSelect: (id: string | null) => void;
  depth: number;
}> = ({ nodes, allItems, selectedSessionId, onSelect, depth }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (value: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  // Expand all top-level nodes by default
  useEffect(() => {
    if (depth === 0) {
      setExpanded(new Set(nodes.map((n) => n.value)));
    }
  }, [nodes, depth]);

  return (
    <div className={depth > 0 ? 'ml-3 border-l border-gray-200 pl-1' : ''}>
      {nodes.map((node) => {
        const isLeaf = node.children.length === 0;
        const isExpanded = expanded.has(node.value);
        const sessionCount = node.sessions.length;
        const key = `${depth}-${node.value}`;
        return (
          <div key={key}>
            <button
              onClick={() => {
                if (!isLeaf) toggle(node.value);
                else if (node.sessions.length === 1) onSelect(node.sessions[0].id);
              }}
              className={clsx(
                'w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center gap-1',
                !isLeaf ? 'text-gray-700 hover:bg-gray-100 hover:text-black font-semibold' : 'text-gray-600 hover:bg-gray-100 hover:text-black'
              )}
            >
              {!isLeaf && (
                <span className="text-[8px] text-gray-400 w-3">{isExpanded ? '▾' : '▸'}</span>
              )}
              <span className={clsx('truncate flex-1', node.value === UNASSIGNED && 'italic text-gray-400')}>
                {node.value}
              </span>
              <span className="font-mono text-[9px] text-gray-400">{sessionCount}</span>
            </button>
            {!isLeaf && isExpanded && (
              <GroupedSidebarNodes
                nodes={node.children}
                allItems={allItems}
                selectedSessionId={selectedSessionId}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
            {isLeaf && isExpanded && node.sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={clsx(
                  'w-full text-left px-3 py-1.5 rounded text-[11px] transition-colors ml-3',
                  selectedSessionId === s.id ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-black'
                )}
              >
                <span className="truncate block">{s.title}</span>
                <span className={clsx('font-mono text-[9px]', selectedSessionId === s.id ? 'text-gray-300' : 'text-gray-400')}>{fmtShort(s.ended_at)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
};

// ─── Session Sidebar ──────────────────────────────────────────────────────────

const SessionSidebar: React.FC<{
  sessions: TrackerSession[];
  allItems: TrackerItem[];
  selectedSessionId: string | null;
  onSelect: (id: string | null) => void;
  onDeleteSession: (id: string) => Promise<void>;
  onUpdateSession: (id: string, updates: Partial<Pick<TrackerSession, 'title' | 'ended_at'>>) => Promise<void>;
  groupedNodes?: GroupNode[];
  isGrouped?: boolean;
}> = ({ sessions, allItems, selectedSessionId, onSelect, onDeleteSession, onUpdateSession, groupedNodes, isGrouped }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDate, setEditDate] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  function startEdit(s: TrackerSession, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(s.id);
    setEditTitle(s.title);
    setEditDate(s.ended_at.split('T')[0]);
    setTimeout(() => editRef.current?.focus(), 0);
  }

  async function commitEdit(id: string) {
    if (editTitle.trim()) {
      await onUpdateSession(id, { title: editTitle.trim(), ended_at: editDate ? new Date(editDate).toISOString() : undefined });
    }
    setEditingId(null);
  }

  function counts(sid: string) {
    const its = allItems.filter(i => i.session_id === sid);
    return { R: its.filter(i => i.type === 'RISK').length, A: its.filter(i => i.type === 'ACTION').length, Ra: its.filter(i => i.type === 'RATIONALE').length, total: its.length };
  }

  return (
    <aside className="hidden lg:flex flex-col w-56 flex-shrink-0 bg-white border-r border-gray-200 self-stretch overflow-y-auto">
      <div className="px-3 pt-5 pb-4">
        <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest px-2 mb-3">Sessions</p>
        <button onClick={() => onSelect(null)} className={clsx('w-full text-left px-3 py-2.5 rounded-md text-sm font-semibold transition-colors mb-1', selectedSessionId === null ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-black')}>
          All Sessions
          <span className={clsx('ml-2 font-mono text-xs font-normal', selectedSessionId === null ? 'text-gray-300' : 'text-gray-400')}>{allItems.length}</span>
        </button>
        <div className="h-px bg-gray-200 my-3 mx-2" />
        {isGrouped && groupedNodes ? (
          <GroupedSidebarNodes
            nodes={groupedNodes}
            allItems={allItems}
            selectedSessionId={selectedSessionId}
            onSelect={onSelect}
            depth={0}
          />
        ) : (
          sessions.map(s => {
          const { R, A, Ra, total } = counts(s.id);
          const active = selectedSessionId === s.id;
          const editing = editingId === s.id;
          return (
            <div key={s.id} className={clsx('group/session relative rounded-md mb-0.5 transition-colors', active ? 'bg-black' : 'hover:bg-gray-100')}>
              {editing ? (
                <div className="px-3 py-2.5 space-y-1.5" onClick={e => e.stopPropagation()}>
                  <input
                    ref={editRef}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitEdit(s.id); if (e.key === 'Escape') setEditingId(null); }}
                    className="w-full bg-white text-gray-900 text-xs rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-black border border-gray-300"
                    placeholder="Session title…"
                  />
                  <input
                    type="date"
                    value={editDate}
                    onChange={e => setEditDate(e.target.value)}
                    className="w-full bg-white text-gray-700 text-[10px] font-mono rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-black border border-gray-300"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => commitEdit(s.id)} className="flex-1 text-[10px] font-mono bg-black text-white rounded px-2 py-1 hover:bg-gray-800 transition-colors">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-[10px] font-mono text-gray-500 hover:text-black px-2 py-1 transition-colors">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => onSelect(s.id)} className="w-full text-left px-3 py-2.5">
                  <p className={clsx('text-xs font-semibold leading-tight truncate pr-10', active ? 'text-white' : 'text-gray-700')}>{s.title}</p>
                  <p className={clsx('font-mono text-[10px] mt-0.5', active ? 'text-gray-300' : 'text-gray-400')}>{fmtShort(s.ended_at)} · {total}</p>
                  {/* The three counts keep the tracker's own card colours — RISK red,
                      ACTION blue, RATIONALE amber — because here they are the only
                      thing saying what a meeting raised. Lightened on the black row so
                      they stay readable on it rather than going to their 800 shade. */}
                  <div className="flex gap-2 mt-1 font-mono text-[10px]">
                    <span className={active ? 'text-red-300' : 'text-red-600'}>{R}R</span>
                    <span className={active ? 'text-blue-300' : 'text-blue-600'}>{A}A</span>
                    <span className={active ? 'text-amber-300' : 'text-amber-600'}>{Ra}Ra</span>
                  </div>
                </button>
              )}
              {/* Hover actions */}
              {!editing && (
                <div className="absolute top-2 right-2 hidden group-hover/session:flex items-center gap-1">
                  <button
                    onClick={e => startEdit(s, e)}
                    title="Edit session"
                    className={clsx('w-5 h-5 rounded flex items-center justify-center transition-colors text-[10px]', active ? 'text-gray-300 hover:text-white hover:bg-white/20' : 'text-gray-400 hover:text-black hover:bg-gray-200')}
                  >✎</button>
                  <button
                    onClick={async e => { e.stopPropagation(); if (confirm(`Delete "${s.title}" and all its items?`)) await onDeleteSession(s.id); }}
                    title="Delete session"
                    className={clsx('w-5 h-5 rounded flex items-center justify-center transition-colors text-[10px]', active ? 'text-gray-400 hover:text-red-300 hover:bg-white/20' : 'text-gray-400 hover:text-red-600 hover:bg-red-50')}
                  >✕</button>
                </div>
              )}
            </div>
          );
        })
        )}
      </div>
    </aside>
  );
};

// ─── Filter Bar ───────────────────────────────────────────────────────────────

interface Filters { type: TrackerItem['type'] | 'All'; priority: TrackerItem['priority'] | 'All'; status: TrackerItem['status'] | 'All'; assignee: string | 'All'; search: string; review: string | 'All'; line: string | 'All'; }

/** One entry of the design-review filter: the review's id and what to call it. */
interface ReviewOption { id: string; label: string; }

interface FilterBarProps {
  filters: Filters;
  assignees: string[];
  reviewOptions: ReviewOption[];
  /**
   * The lines of the review being looked at, for the filter that narrows to one of
   * them. Same shape as a review option — an id and what to call it — because that
   * is all a select needs.
   */
  lineOptions: ReviewOption[];
  onChange: (f: Filters) => void;
  onOpenPalette: () => void;
  sessions?: TrackerSession[];
  selectedSessionId?: string | null;
  onSelectSession?: (id: string | null) => void;
}

const FilterBar: React.FC<FilterBarProps> = ({ filters, assignees, reviewOptions, lineOptions, onChange, onOpenPalette, sessions, selectedSessionId, onSelectSession }) => {
  // The page's one select style, named locally because every filter below wears it.
  const sel = SELECT;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Mobile session selector — only visible on small screens */}
      {sessions && sessions.length > 0 && onSelectSession && (
        <select
          value={selectedSessionId ?? ''}
          onChange={e => onSelectSession(e.target.value || null)}
          className={clsx(sel, 'lg:hidden')}
        >
          <option value="">All Sessions</option>
          {sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      )}
      <button onClick={onOpenPalette}
        className="flex items-center gap-2 h-[34px] border border-gray-200 rounded-md px-3 text-xs text-gray-500 bg-white hover:border-gray-400 hover:text-black transition-colors w-44">
        <span aria-hidden="true">🔍</span>
        <span className="flex-1 text-left">Search…</span>
        <kbd className="font-mono text-[9px] bg-gray-50 px-1 py-0.5 rounded border border-gray-200 text-gray-400">⌘K</kbd>
      </button>
      <select value={filters.review} onChange={e => onChange({ ...filters, review: e.target.value })} className={sel}
        aria-label="Filter by design review" title="Show only the cards and meetings of one design review">
        <option value="All">All design reviews</option>
        {reviewOptions.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        {/* Always offered, and not only when something is in it: every meeting
            recorded before batch BC has no review, and those have to stay
            reachable rather than becoming an unfilterable remainder. */}
        <option value={NO_DESIGN_REVIEW}>No design review</option>
      </select>
      {/* One line of that review. Offered only when there is a review to have lines
          and more than one of them to choose between: a filter that can only answer
          "everything" is noise, and every card on an install whose database predates
          review_lines is on no line at all. */}
      {lineOptions.length > 1 && (
        <select value={filters.line} onChange={e => onChange({ ...filters, line: e.target.value })} className={sel}
          aria-label="Filter by line" title="Show only the cards and meetings of one line of this design review">
          <option value="All">All lines</option>
          {lineOptions.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      )}
      <select value={filters.type} onChange={e => onChange({ ...filters, type: e.target.value as Filters['type'] })} className={sel}>
        <option value="All">All Types</option>
        {ALL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={filters.priority} onChange={e => onChange({ ...filters, priority: e.target.value as Filters['priority'] })} className={sel}>
        <option value="All">All Priorities</option>
        {ALL_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <select value={filters.status} onChange={e => onChange({ ...filters, status: e.target.value as Filters['status'] })} className={sel}>
        <option value="All">All Statuses</option>
        {ALL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      {assignees.length > 0 && (
        <select value={filters.assignee} onChange={e => onChange({ ...filters, assignee: e.target.value })} className={sel}>
          <option value="All">All Assignees</option>
          {assignees.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      )}
    </div>
  );
};

// ─── Trends View ─────────────────────────────────────────────────────────────

interface TrendsViewProps { sessions: TrackerSession[]; allItems: TrackerItem[]; }

const TrendsView: React.FC<TrendsViewProps> = ({ sessions, allItems }) => {
  // Sort sessions oldest → newest
  const sortedSessions = [...sessions].sort((a, b) => a.ended_at.localeCompare(b.ended_at));

  // Session timeline bar chart data
  const sessionBars = sortedSessions.map(s => {
    const its = allItems.filter(i => i.session_id === s.id);
    return {
      session: s,
      risk: its.filter(i => i.type === 'RISK').length,
      action: its.filter(i => i.type === 'ACTION').length,
      rationale: its.filter(i => i.type === 'RATIONALE').length,
      total: its.length,
    };
  });
  const maxTotal = Math.max(...sessionBars.map(b => b.total), 1);

  // Status distribution
  const total = allItems.length || 1;
  const statusCounts: Record<TrackerItem['status'], number> = { Open: 0, 'In Review': 0, Approved: 0, Rejected: 0 };
  allItems.forEach(i => { statusCounts[i.status] = (statusCounts[i.status] || 0) + 1; });

  // Priority breakdown
  const priorityCounts: Record<TrackerItem['priority'], number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  allItems.forEach(i => { priorityCounts[i.priority] = (priorityCounts[i.priority] || 0) + 1; });

  // Approval rate
  const approved = allItems.filter(i => i.status === 'Approved').length;
  const approvalRate = allItems.length > 0 ? Math.round(approved / allItems.length * 100) : 0;
  const ringR = 40; const ringCirc = 2 * Math.PI * ringR;
  const ringDash = (approvalRate / 100) * ringCirc;

  const statusSegments: { status: TrackerItem['status']; color: string; label: string }[] = [
    { status: 'Open', color: '#9ca3af', label: 'Open' },
    { status: 'In Review', color: '#3b82f6', label: 'In Review' },
    { status: 'Approved', color: '#10b981', label: 'Approved' },
    { status: 'Rejected', color: '#ef4444', label: 'Rejected' },
  ];

  const priorityTiles: { priority: TrackerItem['priority']; border: string; bg: string; text: string }[] = [
    { priority: 'Critical', border: '#ef4444', bg: '#fef2f2', text: '#ef4444' },
    { priority: 'High', border: '#f97316', bg: '#fff7ed', text: '#f97316' },
    { priority: 'Medium', border: '#eab308', bg: '#fefce8', text: '#b45309' },
    { priority: 'Low', border: '#9ca3af', bg: '#f9fafb', text: '#6b7280' },
  ];

  const BAR_W = 48;
  const BAR_H = 160;
  const BAR_GAP = 16;
  const CHART_PAD_L = 36;
  const CHART_PAD_B = 64;
  const chartW = Math.max(sessionBars.length * (BAR_W + BAR_GAP) + CHART_PAD_L + 16, 300);
  const chartH = BAR_H + CHART_PAD_B + 16;

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-8">

        {/* Row 1: Session Timeline + Approval Rate */}
        <div className="flex gap-6 flex-wrap items-start">

          {/* Session Timeline Bar Chart */}
          <div className="flex-1 min-w-[300px] bg-white rounded-lg border border-gray-200 shadow-sm p-5">
            <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-4">Items per Session</p>
            {sessionBars.length === 0 ? (
              <p className="text-xs text-gray-400 font-mono italic">No session data.</p>
            ) : (
              <div className="overflow-x-auto">
                <svg width={chartW} height={chartH} style={{ display: 'block' }}>
                  {/* Y-axis ticks */}
                  {[0, 0.25, 0.5, 0.75, 1].map(t => {
                    const y = 8 + (1 - t) * BAR_H;
                    const val = Math.round(t * maxTotal);
                    return (
                      <React.Fragment key={t}>
                        <line x1={CHART_PAD_L - 4} y1={y} x2={CHART_PAD_L + chartW - CHART_PAD_L - 16} y2={y} stroke="#f3f4f6" strokeWidth={1} />
                        <text x={CHART_PAD_L - 6} y={y + 4} textAnchor="end" fontSize={9} fill="#9ca3af" fontFamily="monospace">{val}</text>
                      </React.Fragment>
                    );
                  })}
                  {/* Bars */}
                  {sessionBars.map((b, idx) => {
                    const x = CHART_PAD_L + idx * (BAR_W + BAR_GAP);
                    const rH = (b.risk / maxTotal) * BAR_H;
                    const aH = (b.action / maxTotal) * BAR_H;
                    const raH = (b.rationale / maxTotal) * BAR_H;
                    const y0 = 8 + BAR_H;
                    return (
                      <g key={b.session.id}>
                        {/* Rationale (bottom) */}
                        <rect x={x} y={y0 - raH} width={BAR_W} height={raH} fill="#fbbf24" rx={raH > 0 ? 2 : 0} />
                        {/* Action (middle) */}
                        <rect x={x} y={y0 - raH - aH} width={BAR_W} height={aH} fill="#3b82f6" />
                        {/* Risk (top) */}
                        <rect x={x} y={y0 - raH - aH - rH} width={BAR_W} height={rH} fill="#ef4444" rx={rH > 0 ? 2 : 0} />
                        {/* Total label */}
                        {b.total > 0 && (
                          <text x={x + BAR_W / 2} y={y0 - raH - aH - rH - 4} textAnchor="middle" fontSize={10} fill="#374151" fontFamily="monospace" fontWeight="600">{b.total}</text>
                        )}
                        {/* Date label rotated */}
                        <text
                          x={x + BAR_W / 2} y={y0 + 10}
                          textAnchor="end"
                          fontSize={9} fill="#9ca3af" fontFamily="monospace"
                          transform={`rotate(-45, ${x + BAR_W / 2}, ${y0 + 10})`}
                        >{fmtShort(b.session.ended_at)}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
            {/* Legend */}
            <div className="flex gap-4 mt-2 flex-wrap">
              {[{ c: '#ef4444', l: 'RISK' }, { c: '#3b82f6', l: 'ACTION' }, { c: '#fbbf24', l: 'RATIONALE' }].map(({ c, l }) => (
                <div key={l} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: c }} />
                  <span className="font-mono text-[10px] text-gray-500">{l}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Approval Rate Ring */}
          <div className="flex-shrink-0 bg-white rounded-lg border border-gray-200 shadow-sm p-5 flex flex-col items-center justify-center min-w-[160px]">
            <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-4 text-center">Approval Rate</p>
            <svg width={100} height={100} viewBox="0 0 100 100">
              <circle cx={50} cy={50} r={ringR} fill="none" stroke="#f3f4f6" strokeWidth={10} />
              <circle cx={50} cy={50} r={ringR} fill="none" stroke="#10b981" strokeWidth={10}
                strokeDasharray={`${ringDash} ${ringCirc - ringDash}`}
                strokeDashoffset={ringCirc / 4}
                strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 0.5s ease' }} />
              <text x={50} y={46} textAnchor="middle" fontSize={18} fontWeight="700" fill="#111827" fontFamily="Inter,system-ui,sans-serif">{approvalRate}%</text>
              <text x={50} y={60} textAnchor="middle" fontSize={9} fill="#9ca3af" fontFamily="monospace">{approved}/{allItems.length}</text>
            </svg>
            <p className="font-mono text-[10px] text-gray-400 mt-2 text-center">items approved</p>
          </div>
        </div>

        {/* Row 2: Status Distribution */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-5">
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-4">Status Distribution</p>
          <div className="flex h-6 rounded-lg overflow-hidden w-full">
            {statusSegments.map(({ status, color }) => {
              const pct = (statusCounts[status] / total) * 100;
              if (pct < 0.5) return null;
              return (
                <div key={status} style={{ width: `${pct}%`, background: color }} title={`${status}: ${statusCounts[status]}`} className="transition-all" />
              );
            })}
          </div>
          <div className="flex gap-6 mt-3 flex-wrap">
            {statusSegments.map(({ status, color, label }) => (
              <div key={status} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: color }} />
                <span className="text-xs text-gray-600">{label}</span>
                <span className="font-mono text-xs text-gray-400">{statusCounts[status]}</span>
                <span className="font-mono text-[10px] text-gray-300">({Math.round((statusCounts[status] / total) * 100)}%)</span>
              </div>
            ))}
          </div>
        </div>

        {/* Row 3: Priority Breakdown */}
        <div>
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-3">Priority Breakdown</p>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {priorityTiles.map(({ priority, border, bg, text }) => (
              <div key={priority} className="rounded-lg border-l-4 p-4 flex flex-col gap-1" style={{ borderLeftColor: border, background: bg }}>
                <span className="text-2xl font-bold tabular-nums" style={{ color: text }}>{priorityCounts[priority]}</span>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-gray-500">{priority}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

// ─── Add Item Modal ───────────────────────────────────────────────────────────

interface AddItemModalProps {
  sessions: TrackerSession[];
  defaultSessionId: string | null;
  defaultStatus: TrackerItem['status'];
  onSave: (item: Omit<TrackerItem, 'id' | 'created_at' | 'updated_at' | 'session'>) => Promise<void>;
  onClose: () => void;
}

const AddItemModal: React.FC<AddItemModalProps> = ({ sessions, defaultSessionId, defaultStatus, onSave, onClose }) => {
  const [type, setType] = useState<TrackerItem['type']>('ACTION');
  const [priority, setPriority] = useState<TrackerItem['priority']>('Medium');
  const [status, setStatus] = useState<TrackerItem['status']>(defaultStatus);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [sessionId, setSessionId] = useState(defaultSessionId ?? sessions[0]?.id ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!title.trim() || !sessionId) return;
    setSaving(true);
    await onSave({
      session_id: sessionId,
      type, priority, status,
      title: title.trim(),
      description: description.trim(),
      assignee: assignee.trim() || null,
      due_date: dueDate || null,
      component_reference: null,
      department: null,
      agent_id: 'manual',
      source_message_ids: null,
      affected_requirement_ids: null,
      impact: null,
      mitigation_strategy: null,
      design_driver: null,
      tradeoff_analysis: null,
    });
    setSaving(false);
    onClose();
  }

  const sel = clsx(SELECT, 'text-sm py-2 w-full');

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[480px] bg-white rounded-lg shadow-2xl border border-gray-200 animate-in fade-in zoom-in-95 duration-150 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900 text-sm">Add Item</h2>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-700 text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {/* Session */}
          {sessions.length > 1 && (
            <div>
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Session</p>
              <select value={sessionId} onChange={e => setSessionId(e.target.value)} className={sel}>
                {sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
          )}
          {/* Type + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Type</p>
              <select value={type} onChange={e => setType(e.target.value as TrackerItem['type'])} className={sel}>
                {ALL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Priority</p>
              <select value={priority} onChange={e => setPriority(e.target.value as TrackerItem['priority'])} className={sel}>
                {ALL_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          {/* Status */}
          <div>
            <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Status</p>
            <div className="flex gap-2">
              {ALL_STATUSES.map(s => (
                <button key={s} onClick={() => setStatus(s)}
                  className={clsx('px-3 py-1.5 rounded-full text-xs font-semibold border transition-all flex-1', status === s ? statusColor[s] + ' border-transparent shadow-sm' : 'bg-white border-gray-200 text-gray-400 hover:border-gray-300')}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          {/* Title */}
          <div>
            <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Title <span className="text-red-400">*</span></p>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave(); }}
              placeholder="Describe the item…"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>
          {/* Description */}
          <div>
            <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Description</p>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional details…"
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black resize-none"
            />
          </div>
          {/* Assignee + Due date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Assignee</p>
              <AssigneeComboBox value={assignee} onChange={setAssignee} />
            </div>
            <div>
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Due Date</p>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-black" />
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <span className="font-mono text-[10px] text-gray-300">⌘↵ to save</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-800 transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!title.trim() || !sessionId || saving}
              className="px-5 py-2 bg-black text-white text-sm font-semibold rounded-md hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? 'Saving…' : 'Add Item'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// ─── Design Review Panel ─────────────────────────────────────────────────────

/**
 * One design review, as far as the tracker is concerned: what it has reviewed,
 * when it met, and what is still open.
 *
 * docs/plan/14 asks the tracker to "show a room's history across revisions", and
 * this is that history minus the 3D — which is the room's job, one click away.
 * Revisions come from listModelRevisions, oldest first, which is the order a
 * history reads in; meetings are this review's tracker_sessions.
 *
 * A review with no stored revisions says so instead of showing an empty box. On
 * an install whose database predates model_revisions every review is in that
 * state, and it is not an error — the meetings and the cards are all still here.
 */
const ReviewPanel: React.FC<{
  reviewId: string;
  review: CurationSummary | null;
  revisions: ModelRevision[];
  meetings: TrackerSession[];
  items: TrackerItem[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
}> = ({ reviewId, review, revisions, meetings, items, selectedSessionId, onSelectSession }) => {
  const open = items.filter(i => !isClosed(i.status)).length;
  const heading = 'font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-2';
  const nothing = 'text-[11px] text-gray-400 font-mono italic';
  return (
    <div className="flex-shrink-0 px-6 py-4 bg-white border-b border-gray-200">
      <div className="flex gap-8 flex-wrap items-start">
        <div className="min-w-[180px] max-w-[240px]">
          <p className={heading}>Design review</p>
          <h2 className="text-sm font-semibold text-gray-900 leading-snug break-words">{review?.title || `Review ${reviewId.slice(0, 8)}`}</h2>
          {review?.description && <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{review.description}</p>}
          <p className="font-mono text-[10px] text-gray-400 mt-2">
            {items.length} cards · {open} open · {meetings.length} {meetings.length === 1 ? 'meeting' : 'meetings'}
          </p>
        </div>
        <div className="flex-1 min-w-[240px]">
          <p className={heading}>Revisions</p>
          {revisions.length === 0 ? (
            <p className={nothing}>No revisions stored for this review.</p>
          ) : (
            <ol className="space-y-1 max-h-28 overflow-y-auto">
              {revisions.map(r => (
                <li key={r.id} className="flex items-baseline gap-2 text-[11px] min-w-0">
                  <span className="font-mono font-bold text-gray-700 flex-shrink-0">Rev {r.revision}</span>
                  <span className="text-gray-500 truncate">{r.line}</span>
                  {r.fileName && <span className="font-mono text-[10px] text-gray-400 truncate">{r.fileName}</span>}
                  <span className="font-mono text-[10px] text-gray-300 ml-auto flex-shrink-0">{fmt(r.createdAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex-1 min-w-[240px]">
          <p className={heading}>Meetings</p>
          {meetings.length === 0 ? (
            <p className={nothing}>No meetings recorded in this review yet.</p>
          ) : (
            <ul className="space-y-0.5 max-h-28 overflow-y-auto">
              {meetings.map(m => (
                <li key={m.id}>
                  <button
                    onClick={() => onSelectSession(selectedSessionId === m.id ? null : m.id)}
                    title={selectedSessionId === m.id ? 'Show every meeting of this review' : 'Show only this meeting'}
                    className={clsx(
                      'w-full text-left flex items-baseline gap-2 px-2 py-1 rounded transition-colors text-[11px]',
                      selectedSessionId === m.id ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-50'
                    )}
                  >
                    <span className="truncate flex-1">{m.title}</span>
                    <span className="font-mono text-[10px] text-gray-400 flex-shrink-0">
                      {fmtShort(m.ended_at)} · {items.filter(i => i.session_id === m.id).length}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Main Page ────────────────────────────────────────────────────────────────

type ViewMode = 'board' | 'list' | 'matrix' | 'trends';

/**
 * The map of a design review's sessions, fetched when it is opened.
 *
 * Batch BK. App.tsx does not code-split its routes, so this page is in the main
 * chunk and a static import here would put the map in it too — and the map is only
 * ever drawn for somebody who pressed the button. Lazy here AND in
 * components/UI/Interface.tsx, which shows the same component over the room's canvas.
 */
const SessionMap = React.lazy(() => import('../components/review/SessionMap'));

const TrackerPage: React.FC = () => {
  const location = useLocation();
  // Opening a line's room from the map below. `openLine` and not a <Link> to the same
  // address: pages/RoomPage admits an arrival by its router state or by the mark
  // openLine leaves in sessionStorage, and a link carries neither — so it navigates to
  // exactly the right address and is bounced straight back here.
  const navigate = useNavigate();
  // A link in from the session map names the meeting it wants
  // (/tracker?session=<id>&review=<id>), so a card listed under a stop on the map
  // lands on that card's board rather than on the tracker's front door. Read once,
  // on the first render, because this page keeps no router state to stay in step
  // with afterwards — the filters below are the user's from that point on.
  const [arrival] = useState(() => {
    const params = new URLSearchParams(location.search);
    return { session: params.get('session'), review: params.get('review') };
  });
  const [sessions, setSessions] = useState<TrackerSession[]>([]);
  // Whose name the top bar's chip carries: the same vp_user record the lobby edits,
  // read through the same hook, so a name typed on either screen is the name on both.
  // Written back as a PATCH — dropping accountId here would sign the person out of
  // their own lobby the moment they picked a colour on this screen.
  const [identity, setIdentity] = useIdentity();
  const chip = {
    name: identity?.name ?? '',
    color: identity?.color ?? AVATAR_COLORS[0],
    role: identity?.role ?? '',
  };
  const writeIdentity = (patch: Partial<typeof chip>) => {
    setIdentity({ ...(identity ?? { name: '', color: AVATAR_COLORS[0] }), ...chip, ...patch });
  };
  const [allItems, setAllItems] = useState<TrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(arrival.session);
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [selectedItem, setSelectedItem] = useState<TrackerItem | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [filters, setFilters] = useState<Filters>({ type: 'All', priority: 'All', status: 'All', assignee: 'All', search: '', review: arrival.review ?? 'All', line: 'All' });
  const [addItemState, setAddItemState] = useState<{ open: boolean; status: TrackerItem['status'] }>({ open: false, status: 'Open' });
  const [groupBy, setGroupBy] = useState<GroupByChoice>({ fieldIds: [] });
  const [groupFilters, setGroupFilters] = useState<GroupFilters>({});
  const [labelSettingsOpen, setLabelSettingsOpen] = useState(false);
  // The session map is opened rather than always drawn: a review that has met twenty
  // times has twenty stops in it, and the tracker's job the rest of the time is the
  // board. Read (and drawn) only while it is open.
  const [mapOpen, setMapOpen] = useState(false);
  // Batch BC: the design reviews a meeting or card can belong to, the revisions
  // each of them has stored, and when each closed card was closed. All three
  // start empty and stay empty on an install whose database predates them, which
  // is the state the tracker already rendered.
  const [reviews, setReviews] = useState<CurationSummary[]>([]);
  const [revisionsByReview, setRevisionsByReview] = useState<Record<string, ModelRevision[]>>({});
  const [closedAtByItem, setClosedAtByItem] = useState<Record<string, string>>({});
  // Batch BK (docs/plan/15): the lines of each design review on screen, so a card can
  // say "Main line · S3" and the filter can offer one of them. Empty on an install
  // whose database has no review_lines yet, which costs a label and nothing else.
  const [linesByReview, setLinesByReview] = useState<Record<string, ReviewLine[]>>({});

  // Label fields store
  const labelFields = useLabelFieldsStore((s) => s.fields);
  const loadLabelFields = useLabelFieldsStore((s) => s.load);
  const labelFieldsLoaded = useLabelFieldsStore((s) => s.loaded);

  useEffect(() => {
    if (!labelFieldsLoaded) loadLabelFields();
  }, [labelFieldsLoaded, loadLabelFields]);

  // Hydrate group-by choice from localStorage, pruning deleted fields
  useEffect(() => {
    const saved = loadGroupByChoice();
    setGroupBy(pruneGroupByChoice(saved, labelFields));
    setGroupFilters(loadGroupFilters());
  }, [labelFields]);

  // Persist group-by choice
  const updateGroupBy = useCallback((choice: GroupByChoice) => {
    setGroupBy(choice);
    saveGroupByChoice(choice);
  }, []);

  const updateGroupFilters = useCallback((f: GroupFilters) => {
    setGroupFilters(f);
    saveGroupFilters(f);
  }, []);

  const fetchSessions = useCallback(async () => {
    const { data } = await supabase.from('tracker_sessions').select('*').order('ended_at', { ascending: false });
    setSessions((data as TrackerSession[]) ?? []);
  }, []);

  const fetchItems = useCallback(async () => {
    let q = supabase.from('tracker_items').select('*, session:tracker_sessions(*)').order('created_at', { ascending: false });
    if (selectedSessionId) q = q.eq('session_id', selectedSessionId);
    const { data } = await q;
    setAllItems((data as TrackerItem[]) ?? []);
  }, [selectedSessionId]);

  useEffect(() => {
    async function init() { setLoading(true); await Promise.all([fetchSessions(), fetchItems()]); setLoading(false); }
    init();
  }, [fetchSessions, fetchItems]);

  // Every design review on this install, not only the listed ones: the tracker is
  // "every card from every design review, filterable", and a link-only review has
  // cards too and has to be reachable from them. listAllCurations answers [] when
  // the read fails, so the worst case is a filter with nothing in it.
  useEffect(() => {
    let cancelled = false;
    listAllCurations()
      .then(list => { if (!cancelled) setReviews(list); })
      .catch(() => { if (!cancelled) setReviews([]); });
    return () => { cancelled = true; };
  }, []);

  // The review being looked at, when one is. 'All' and 'No design review' are
  // filters rather than a review, and neither has a panel.
  const selectedReviewId = filters.review === 'All' || filters.review === NO_DESIGN_REVIEW
    ? null
    : filters.review;

  // The revision history behind the cards on screen: one read per design review
  // that has a card pointing at a revision, plus the review being looked at,
  // whose panel lists every revision whether or not a card names one.
  //
  // Driven by `raised_on_revision` rather than by "every review" on purpose. On an
  // install whose database predates batch BC no card has one, so this effect makes
  // no request at all and the page costs exactly what it cost before — which is
  // what "renders the tracker exactly as it does today" has to mean in practice.
  // A review already read is not read again, and a failure stores the empty
  // history listModelRevisions would have answered anyway.
  useEffect(() => {
    const wanted: string[] = [];
    for (const item of allItems) {
      const reviewId = item.raised_on_revision ? reviewOf(item) : null;
      if (reviewId && !wanted.includes(reviewId)) wanted.push(reviewId);
    }
    if (selectedReviewId && !wanted.includes(selectedReviewId)) wanted.push(selectedReviewId);
    const missing = wanted.filter(id => !(id in revisionsByReview));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(async id => ({ id, revisions: await listModelRevisions(id) })))
      .then(loaded => {
        if (cancelled) return;
        setRevisionsByReview(prev => {
          const next = { ...prev };
          for (const entry of loaded) next[entry.id] = entry.revisions;
          return next;
        });
      })
      .catch(() => { /* a review whose history cannot be read has no continuity to show */ });
    return () => { cancelled = true; };
  }, [allItems, selectedReviewId, revisionsByReview]);

  // The lines behind the cards on screen: one read per design review that has a card
  // on a line, plus the review being looked at, whose filter has to offer every line
  // whether or not a card names one.
  //
  // Driven by `line_id` for the same reason the revision read is driven by
  // `raised_on_revision`: on an install whose database predates batch BK no card has
  // one, so this effect makes no request at all and the page costs what it cost
  // before. A review already read is not read again, and a failure stores the empty
  // list listLines would have answered anyway.
  useEffect(() => {
    const wanted: string[] = [];
    for (const item of allItems) {
      const reviewId = lineOf(item) ? reviewOf(item) : null;
      if (reviewId && !wanted.includes(reviewId)) wanted.push(reviewId);
    }
    if (selectedReviewId && !wanted.includes(selectedReviewId)) wanted.push(selectedReviewId);
    const missing = wanted.filter(id => !(id in linesByReview));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(async id => ({ id, lines: await listLines(id) })))
      .then(loaded => {
        if (cancelled) return;
        setLinesByReview(prev => {
          const next = { ...prev };
          for (const entry of loaded) next[entry.id] = entry.lines;
          return next;
        });
      })
      .catch(() => { /* a review whose lines cannot be read has no line labels to show */ });
    return () => { cancelled = true; };
  }, [allItems, selectedReviewId, linesByReview]);

  // When each closed card was closed — the other half of "Closed on Rev B · 12
  // Mar". tracker_status_history has no revision column and this batch's schema is
  // fixed, so the revision is derived by lining the two histories up by time in
  // lib/trackerContinuity.ts; all this does is fetch the moments.
  //
  // Newest first and capped, because the cards on screen are the recent ones and a
  // tracker with years of status changes should still answer for those. Read again
  // whenever the items change, so dragging a card to Approved gives it its closing
  // line without a reload. Quiet on failure: an empty table of moments only means
  // cards say "Raised on Rev A" instead of naming the revision they closed in.
  useEffect(() => {
    if (!allItems.some(item => isClosed(item.status))) return;
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from('tracker_status_history')
        .select('item_id,created_at')
        .in('status', ['Approved', 'Rejected'])
        .order('created_at', { ascending: false })
        .limit(1000);
      if (cancelled || !data) return;
      const newest: Record<string, string> = {};
      for (const row of data as Array<{ item_id: string; created_at: string }>) {
        // Descending, so the first row for an item is its most recent close — the
        // one that counts for a card that was reopened and closed again.
        if (!(row.item_id in newest)) newest[row.item_id] = row.created_at;
      }
      setClosedAtByItem(newest);
    }
    load();
    return () => { cancelled = true; };
  }, [allItems]);

  // Global Cmd+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setPaletteOpen(p => !p); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const updateItem = useCallback(async (id: string, updates: Partial<TrackerItem>) => {
    const now = new Date().toISOString();
    await supabase.from('tracker_items').update({ ...updates, updated_at: now }).eq('id', id);
    if (updates.status) {
      await supabase.from('tracker_status_history').insert({ item_id: id, status: updates.status, changed_by: 'You' });
    }
    const merged = { ...updates, updated_at: now };
    setAllItems(prev => prev.map(i => i.id === id ? { ...i, ...merged } : i));
    setSelectedItem(prev => prev?.id === id ? { ...prev, ...merged } : prev);
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    // Delete items first (avoids FK issues if no cascade)
    await supabase.from('tracker_items').delete().eq('session_id', id);
    await supabase.from('tracker_sessions').delete().eq('id', id);
    if (selectedSessionId === id) setSelectedSessionId(null);
    setSessions(prev => prev.filter(s => s.id !== id));
    setAllItems(prev => prev.filter(i => i.session_id !== id));
  }, [selectedSessionId]);

  const updateSession = useCallback(async (id: string, updates: Partial<Pick<TrackerSession, 'title' | 'ended_at'>>) => {
    await supabase.from('tracker_sessions').update(updates).eq('id', id);
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s));
  }, []);

  const deleteItem = useCallback(async (id: string) => {
    await supabase.from('tracker_comments').delete().eq('item_id', id);
    await supabase.from('tracker_status_history').delete().eq('item_id', id);
    await supabase.from('tracker_items').delete().eq('id', id);
    setAllItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const createItem = useCallback(async (item: Omit<TrackerItem, 'id' | 'created_at' | 'updated_at' | 'session'>) => {
    const now = new Date().toISOString();
    const { data } = await supabase.from('tracker_items').insert({ ...item, created_at: now, updated_at: now }).select('*, session:tracker_sessions(*)').single();
    if (data) setAllItems(prev => [data as TrackerItem, ...prev]);
  }, []);

  async function handleSeed() {
    if (!confirm('Insert 3 demo sessions with 16 engineering items?')) return;
    setSeeding(true);
    await seedDemoData();
    // The demo sessions belong to no design review, so seeding while one is
    // selected would appear to do nothing at all. The line goes with it: it names a
    // line of that review, and the demo sessions are on none.
    setFilters(f => ({ ...f, review: 'All', line: 'All' }));
    setSelectedSessionId(null);
    await Promise.all([fetchSessions(), fetchItems()]);
    setSeeding(false);
  }

  const assignees = useMemo(() => Array.from(new Set(allItems.map(i => i.assignee).filter((a): a is string => !!a))), [allItems]);

  // The design review filter, applied to a review id that may be null: 'All'
  // keeps everything, NO_DESIGN_REVIEW keeps the meetings and cards that belong to
  // no review — every one recorded before this batch, and every ad-hoc room — and
  // anything else keeps one review's.
  const matchesReview = useCallback((reviewId: string | null) => {
    if (filters.review === 'All') return true;
    if (filters.review === NO_DESIGN_REVIEW) return !reviewId;
    return reviewId === filters.review;
  }, [filters.review]);

  // One line of the review being looked at: the main line, or one of its variants.
  // 'All' is the answer for every install whose database has no review_lines yet, and
  // for every card recorded before the backfill gave it a line — those keep showing
  // exactly where they showed before.
  const matchesLine = useCallback((item: TrackerItem) => {
    if (filters.line === 'All') return true;
    return lineOf(item) === filters.line;
  }, [filters.line]);

  const matchesSessionLine = useCallback((session: TrackerSession) => {
    if (filters.line === 'All') return true;
    return (session.line_id ?? null) === filters.line;
  }, [filters.line]);

  // The review's cards, before the type/priority/status/assignee filters: what its
  // panel counts and what Trends draws. Trends has always ignored the card
  // filters, and the review is a scope rather than one of them.
  const reviewItems = useMemo(
    () => allItems.filter(item => matchesReview(reviewOf(item)) && matchesLine(item)),
    [allItems, matchesReview, matchesLine],
  );

  const visibleSessions = useMemo(
    () => sessions.filter(s => matchesReview(s.review_id ?? null) && matchesSessionLine(s)),
    [sessions, matchesReview, matchesSessionLine],
  );

  const filteredItems = useMemo(() => reviewItems.filter(item => {
    if (filters.type !== 'All' && item.type !== filters.type) return false;
    if (filters.priority !== 'All' && item.priority !== filters.priority) return false;
    if (filters.status !== 'All' && item.status !== filters.status) return false;
    if (filters.assignee !== 'All' && item.assignee !== filters.assignee) return false;
    return true;
  }), [reviewItems, filters]);

  // What the design-review filter offers. A review listAllCurations did not return
  // — past its row limit, or deleted since the meeting was recorded — is still
  // named here by its id, because otherwise its cards could never be filtered for.
  const reviewOptions = useMemo<ReviewOption[]>(() => {
    const options = reviews.map(r => ({ id: r.id, label: r.title || `Review ${r.id.slice(0, 8)}` }));
    for (const s of sessions) {
      const id = s.review_id;
      if (id && !options.some(o => o.id === id)) options.push({ id, label: `Review ${id.slice(0, 8)}` });
    }
    return options;
  }, [reviews, sessions]);

  // Grouped sessions: apply label filters, then group by chosen fields.
  const groupedSessions = useMemo(() => {
    const filtered = filterSessions(visibleSessions, groupFilters);
    return groupSessions(filtered, groupBy.fieldIds);
  }, [visibleSessions, groupBy.fieldIds, groupFilters]);

  const stats = useMemo(() => computeStats(reviewItems), [reviewItems]);

  // What the line filter offers: the lines of this review that are still being explored,
  // named the way the session map names them. Batch BX took the finished ones OUT, and
  // it is a narrowing rather than a loss: a merged variant's cards are on the line it
  // went into, and a dropped one's are closed with the reason on them, so both are
  // already reachable from the filter entries that remain — and each of those cards says
  // for itself where it came from ("Raised in Variant B · merged into Variant A 26
  // Sep"), which is the sentence a filter entry can never carry. What an entry for a
  // closed line WAS is a board that cannot be opened: its room has nobody in it. Empty
  // until the review's lines have been read, which is also when the select hides itself
  // — a filter with one entry in it is not a filter.
  const lineOptions = useMemo<ReviewOption[]>(() => {
    if (!selectedReviewId) return [];
    return activeLines(linesByReview[selectedReviewId] ?? []).map(line => ({
      id: line.id,
      label: lineFilterLabel(line) ?? 'Line',
    }));
  }, [selectedReviewId, linesByReview]);

  // A filter narrowed to a line that has just been merged or dropped has to be let go of
  // here, because its own select can no longer do it: the entry is gone from the list, so
  // the select shows "All lines" while `filters.line` still names the closed line and the
  // board stays empty with nothing on it to press. Only once this review's lines have
  // actually been read — `afterLineChange` empties the table before the re-read lands, and
  // a read in flight must not look like a line that went away.
  useEffect(() => {
    if (!selectedReviewId || !(selectedReviewId in linesByReview)) return;
    if (filters.line === 'All') return;
    if (lineOptions.some(option => option.id === filters.line)) return;
    setFilters(f => (f.line === 'All' ? f : { ...f, line: 'All' }));
  }, [filters.line, lineOptions, linesByReview, selectedReviewId]);

  // The map of the review being looked at, drawn above its cards. Read only while it
  // is open AND a review is selected: with 'All design reviews' there is no one
  // history to draw, and useSessionMap(null) makes no request at all.
  const sessionMap = useSessionMap(mapOpen ? selectedReviewId : null);
  // Pulled out so `afterLineChange` below can depend on the stable callback rather
  // than on the object the hook builds fresh on every render.
  const refreshMap = sessionMap.refresh;

  // Whether this person may start, adopt or drop a variant of the review being looked
  // at. The same question the room asks, answered from the same table
  // (lib/reviews/roles.ts): on a deployment with accounts it is their role in THIS
  // review, and on the default install with no accounts it is the meeting host — and
  // the tracker is holding no meeting, so useReviewRole's own reading of "nobody has
  // been named, so you are the host" is the answer there. That is what lets the people
  // who run a review on a self-hosted install run its variants from the tracker as
  // well as from the room. Hiding the actions is not the enforcement: the endpoint
  // checks the caller's own token against the roster, and would refuse the press.
  const { can: mayDoInReview, loading: reviewRoleLoading } = useReviewRole({
    reviewId: selectedReviewId,
    sessionHostId: null,
    localUserId: null,
  });
  const mayEditLines = mayDoInReview('editReview') && !reviewRoleLoading;
  // The same two facts, handed to the endpoint as well: the tracker is holding no
  // meeting, so nobody has been named as its host, and "nobody has been named" is the
  // app's own spelling of "you are the host" (lib/reviews/useReviewRole.isMeetingHostOf
  // — the reading every other screen in the app uses for a solo session). It decides
  // anything only on an install with no accounts, where there is no token to check;
  // with accounts the endpoint ignores it and asks the roster.
  const trackerHostsTheMeeting = isMeetingHostOf(null, null);

  // Adopting moves cards between lines and stamps them with the moment they were
  // taken in; dropping closes the variant's open cards with a reason. Every one of
  // those rows is already on screen — the board, the sidebar's counts, the line
  // filter's own labels — so all of it is read again rather than patched: the
  // endpoint is the only place that knows what the write did.
  const afterLineChange = useCallback(() => {
    refreshMap();
    setLinesByReview({});
    void fetchItems();
    void fetchSessions();
    // `refreshMap` rather than `sessionMap`: the hook answers a fresh object every
    // render, so depending on it would make this callback new on every render too.
  }, [refreshMap, fetchItems, fetchSessions]);

  const continuityData = useMemo(
    () => ({ revisionsByReview, closedAtByItem, linesByReview }),
    [revisionsByReview, closedAtByItem, linesByReview],
  );

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#f3f4f6]">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-gray-300 border-t-black rounded-full animate-spin mx-auto" />
          <p className="font-mono text-xs text-gray-500">Loading tracker…</p>
        </div>
      </div>
    );
  }

  return (
    <CardContinuityProvider value={continuityData}>
      {/* Its own scroll container, exactly like the lobby's: index.html fixes the body
          and hides its overflow for the 3D room, so a page taller than the window must
          scroll itself or the part under the fold is unreachable. The board's columns
          still scroll inside it — the body row keeps a floor, so a page whose chrome
          has grown (a review panel, an open session map) overflows the container and
          the container scrolls, instead of squeezing the board to nothing. */}
      <div
        className="h-full overflow-y-auto bg-[#f3f4f6] font-sans text-gray-900"
        data-testid="tracker-scroll"
        style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
      >
        <div className="flex flex-col min-h-full">
        {/* The bar the lobby wears, with this screen's own controls in its slot. The
            black bar this replaces said "Viewpoint Tracker" in mono caps and then
            offered four gray-on-black buttons and a "← Arena" link; the brand, the way
            back to the lobby and the name chip are all the shared bar's now, and the
            four buttons are pills of the same shape as its links.

            `canSignOut` is FALSE. The chip edits the name, the colour and the role —
            the same vp_user record the lobby's chip edits — but ending a session stays
            the lobby's, one click away on the brand or the Lobby pill: a second
            sign-out path is a second thing to keep honest about the session. */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 z-30">
          <LobbyTopBar
            here="tracker"
            name={chip.name}
            color={chip.color}
            role={chip.role}
            canSignOut={false}
            nameEditable={!identity?.accountId}
            onName={(next) => writeIdentity({ name: next })}
            onColor={(next) => writeIdentity({ color: next })}
            onRole={(next) => writeIdentity({ role: next })}
            onSignOut={() => {}}
            actions={
              <>
                {visibleSessions.length > 0 && (
                  <span
                    className="inline-flex items-center h-9 px-3 rounded-md border border-gray-200 bg-white font-mono text-[10px] text-gray-500"
                    data-testid="tracker-counts"
                  >
                    {visibleSessions.length} sessions · {reviewItems.length} items
                  </span>
                )}
                <button onClick={handleSeed} disabled={seeding} className={PILL} data-testid="seed-demo-data">
                  {seeding ? 'Seeding…' : '+ Demo Data'}
                </button>
                <button onClick={() => setLabelSettingsOpen(true)} className={PILL} data-testid="label-fields">
                  <span aria-hidden="true">🏷</span> Label fields
                </button>
                <button onClick={() => setIntegrationsOpen(true)} className={PILL} data-testid="integrations">
                  <span aria-hidden="true">⚡</span> Integrations
                </button>
                <button
                  onClick={() => exportToCSV(filteredItems)}
                  disabled={filteredItems.length === 0}
                  className={clsx(PILL, 'disabled:opacity-40')}
                  data-testid="export-csv"
                >
                  ↓ Export CSV
                </button>
              </>
            }
          />
        </div>

        {/* Stats */}
        {reviewItems.length > 0 && <StatsBar stats={stats} />}

        {/* Body */}
        <div className="flex flex-1 overflow-hidden min-h-[calc(100dvh-9rem)]">
          <SessionSidebar sessions={visibleSessions} allItems={reviewItems} selectedSessionId={selectedSessionId}
            onSelect={id => { setSelectedSessionId(id); setSelectedItem(null); }}
            onDeleteSession={deleteSession}
            onUpdateSession={updateSession}
            groupedNodes={groupedSessions}
            isGrouped={groupBy.fieldIds.length > 0}
          />

          <main className="flex-1 flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-6 py-3 bg-white border-b border-gray-200 flex-wrap">
              <FilterBar filters={filters} assignees={assignees} reviewOptions={reviewOptions} lineOptions={lineOptions}
                onChange={next => {
                  // Moving to another design review leaves the meeting that was
                  // open in the last one: fetchItems scopes the board to it, and a
                  // session the review filter hides would otherwise empty the view.
                  // It leaves the LINE too, which belongs to the review rather than
                  // to the filters — an id from the last review would match nothing
                  // in this one and silently empty the board.
                  const moved = next.review !== filters.review;
                  if (moved) { setSelectedSessionId(null); setSelectedItem(null); }
                  setFilters(moved ? { ...next, line: 'All' } : next);
                }}
                onOpenPalette={() => setPaletteOpen(true)} sessions={visibleSessions} selectedSessionId={selectedSessionId} onSelectSession={id => { setSelectedSessionId(id); setSelectedItem(null); }} />
              <button
                onClick={() => setAddItemState({ open: true, status: 'Open' })}
                className="flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-black border border-black text-white text-xs font-semibold hover:bg-gray-800 transition-colors ml-auto"
              >
                + New Item
              </button>
              {/* The four ways of looking at the same set of cards, as the lobby's
                  filter chips: black for the one that is on, white for the three that
                  are not. The emoji they carried were the last decoration on this page
                  that nothing else in the app uses — its icons are lucide's, and a chip
                  that says "board" needs no picture of one. */}
              <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="How to show the cards">
                {(['board', 'list', 'matrix', 'trends'] as ViewMode[]).map(m => (
                  <button key={m} onClick={() => setViewMode(m)} aria-pressed={viewMode === m}
                    className={clsx('inline-flex items-center h-8 px-3 rounded-full border text-xs font-semibold capitalize transition-colors', viewMode === m ? CHIP_ON : CHIP_OFF)}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Group by bar — only visible when label fields exist */}
            {labelFields.length > 0 && (
              <GroupByBar
                fields={labelFields}
                choice={groupBy}
                onChange={updateGroupBy}
                filters={groupFilters}
                onFiltersChange={updateGroupFilters}
                sessions={visibleSessions}
              />
            )}

            {/* One design review: its revisions, its meetings, and how much of it
                is still open. The cards themselves are the board below, filtered
                to the same review. */}
            {selectedReviewId && (
              <ReviewPanel
                reviewId={selectedReviewId}
                review={reviews.find(r => r.id === selectedReviewId) ?? null}
                revisions={revisionsByReview[selectedReviewId] ?? []}
                meetings={visibleSessions}
                items={reviewItems}
                selectedSessionId={selectedSessionId}
                onSelectSession={id => { setSelectedSessionId(id); setSelectedItem(null); }}
              />
            )}

            {/* The same map the room's Sessions button opens: every meeting of this
                review, its main line and its variants, above the cards they produced.
                Folded away until asked for, so the board still gets the page. */}
            {selectedReviewId && (
              <div className="flex-shrink-0 bg-white border-b border-gray-200">
                <button
                  onClick={() => setMapOpen(v => !v)}
                  className="w-full flex items-center gap-2 px-6 py-2 text-left hover:bg-gray-50 transition-colors"
                  aria-expanded={mapOpen}
                >
                  <span className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Session map</span>
                  <span className="text-[11px] text-gray-500">
                    {mapOpen ? `${sessionMap.sessions.length} sessions` : 'show every session of this design review'}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-gray-400">{mapOpen ? '▴' : '▾'}</span>
                </button>
                {mapOpen && (
                  <div className="px-6 pb-4 h-[340px]">
                    <React.Suspense fallback={null}>
                      <SessionMap
                        reviewTitle={reviews.find(r => r.id === selectedReviewId)?.title ?? null}
                        lines={sessionMap.lines}
                        sessions={sessionMap.sessions}
                        revisions={sessionMap.revisions}
                        cards={sessionMap.cards}
                        emptyMessage={sessionMap.loading ? 'Reading this design review’s sessions…' : undefined}
                        // The same three actions the room's map offers, gated on the
                        // same rule. Starting a variant from here opens its room; the
                        // tracker has no meeting in it, so adopting and dropping are
                        // what this copy of the map is mostly for.
                        reviewId={selectedReviewId}
                        mayEditLines={mayEditLines}
                        isMeetingHost={trackerHostsTheMeeting}
                        onChanged={afterLineChange}
                        onOpenLine={lineId => openLine(navigate, selectedReviewId, lineId)}
                        readTranscript={sessionMap.readTranscript}
                      />
                    </React.Suspense>
                  </div>
                )}
              </div>
            )}

            {/* Content */}
            {sessions.length === 0 && !selectedReviewId ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
                <div className="text-5xl mb-2">📋</div>
                <p className="text-gray-500 text-sm max-w-xs leading-relaxed">No sessions yet. End a meeting to see items here, or load demo data to explore the tracker.</p>
                <button onClick={handleSeed} disabled={seeding}
                  className="mt-2 px-5 py-2.5 bg-black text-white text-sm font-semibold rounded-md hover:bg-gray-800 disabled:opacity-40 transition-colors">
                  {seeding ? 'Loading…' : 'Load Demo Data'}
                </button>
              </div>
            ) : (
              <div className="flex-1 overflow-hidden p-6">
                {viewMode === 'board' && <BoardView items={filteredItems} onItemClick={setSelectedItem} onStatusChange={(id, s) => updateItem(id, { status: s })} onAddItem={status => setAddItemState({ open: true, status })} />}
                {viewMode === 'list' && <ListView items={filteredItems} onItemClick={setSelectedItem} />}
                {viewMode === 'matrix' && <RiskMatrix items={filteredItems} onItemClick={setSelectedItem} />}
                {viewMode === 'trends' && <TrendsView sessions={visibleSessions} allItems={reviewItems} />}
              </div>
            )}
          </main>
        </div>

        {/* Drawer */}
        {selectedItem && <ItemDrawer item={selectedItem} onClose={() => setSelectedItem(null)} onUpdate={updateItem} onDelete={deleteItem} />}

        {/* Add Item Modal */}
        {addItemState.open && (
          <AddItemModal
            sessions={visibleSessions}
            defaultSessionId={selectedSessionId}
            defaultStatus={addItemState.status}
            onSave={createItem}
            onClose={() => setAddItemState({ open: false, status: 'Open' })}
          />
        )}

        {/* Command Palette */}
        {paletteOpen && <CommandPalette items={reviewItems} sessions={visibleSessions} onItemClick={item => { setSelectedItem(item); }} onClose={() => setPaletteOpen(false)} />}

        {/* Label Fields Settings */}
        {labelSettingsOpen && (
          <LabelFieldsSettings
            fields={labelFields}
            onClose={() => setLabelSettingsOpen(false)}
          />
        )}

        {/* Integrations Panel */}
        {integrationsOpen && (
          <IntegrationsPanel
            session={visibleSessions.find(s => s.id === selectedSessionId) ?? visibleSessions[0] ?? null}
            items={filteredItems}
            onClose={() => setIntegrationsOpen(false)}
          />
        )}
        </div>
      </div>
    </CardContinuityProvider>
  );
};

// ─── Group By Bar ────────────────────────────────────────────────────────────

const GroupByBar: React.FC<{
  fields: LabelField[];
  choice: GroupByChoice;
  onChange: (c: GroupByChoice) => void;
  filters: GroupFilters;
  onFiltersChange: (f: GroupFilters) => void;
  sessions: TrackerSession[];
}> = ({ fields, choice, onChange, filters, onFiltersChange, sessions }) => {
  const sel = clsx(SELECT, 'px-2 py-1');

  const availableFields = fields.filter((f) => !choice.fieldIds.includes(f.id));

  const addField = (fieldId: string) => {
    if (choice.fieldIds.length >= 3) return;
    onChange({ fieldIds: [...choice.fieldIds, fieldId] });
  };

  const removeField = (idx: number) => {
    const next = choice.fieldIds.filter((_, i) => i !== idx);
    onChange({ fieldIds: next });
    // Clean up filters for removed field
    const removedId = choice.fieldIds[idx];
    const { [removedId]: _, ...rest } = filters;
    onFiltersChange(rest);
  };

  const moveField = (idx: number, dir: -1 | 1) => {
    const arr = [...choice.fieldIds];
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    onChange({ fieldIds: arr });
  };

  return (
    <div className="flex-shrink-0 flex items-center gap-3 px-6 py-2 bg-white border-b border-gray-200 flex-wrap">
      <span className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Group by</span>
      {choice.fieldIds.length === 0 && (
        <span className="text-xs text-gray-400 italic">All sessions</span>
      )}
      {choice.fieldIds.map((fid, idx) => {
        const field = fields.find((f) => f.id === fid);
        if (!field) return null;
        const filterVal = filters[fid] ?? '';
        const values = collectFieldValues(sessions, fid);
        return (
          <div key={fid} className="flex items-center gap-1">
            {idx > 0 && <span className="text-gray-300 text-xs">→</span>}
            <span className="text-xs font-semibold text-gray-700 bg-white border border-gray-200 rounded px-2 py-1">{field.name}</span>
            <button onClick={() => moveField(idx, -1)} disabled={idx === 0}
              className="text-gray-400 hover:text-gray-700 disabled:opacity-20 text-xs px-0.5">←</button>
            <button onClick={() => moveField(idx, 1)} disabled={idx === choice.fieldIds.length - 1}
              className="text-gray-400 hover:text-gray-700 disabled:opacity-20 text-xs px-0.5">→</button>
            <button onClick={() => removeField(idx)}
              className="text-gray-400 hover:text-red-400 text-xs px-0.5">✕</button>
            {values.length > 0 && (
              <select value={filterVal} onChange={(e) => onFiltersChange({ ...filters, [fid]: e.target.value })}
                className={clsx(sel, 'text-[10px]')}>
                <option value="">All</option>
                {values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
          </div>
        );
      })}
      {choice.fieldIds.length < 3 && availableFields.length > 0 && (
        <select value="" onChange={(e) => { if (e.target.value) addField(e.target.value); }}
          className={clsx(sel, 'text-[10px]')}>
          <option value="">+ Add field…</option>
          {availableFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
    </div>
  );
};

export default TrackerPage;
