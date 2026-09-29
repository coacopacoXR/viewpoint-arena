-- Viewpoint Arena — Tracker Schema
-- Run this in: Supabase dashboard → SQL Editor → New query

-- Sessions (one per meeting)
create table if not exists tracker_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  title text not null default 'Design Review',
  ended_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  participant_count int not null default 1,
  model_name text
);

-- Labels snapshot copied from the review at meeting-end (added 2026-09-23).
-- Lets the tracker group sessions by the review's label values at the time.
alter table tracker_sessions
  add column if not exists labels jsonb not null default '{}'::jsonb;

-- Which design review this meeting belonged to, and what was on screen
-- (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md batch BC).
--
-- `review_id` is review_curations.id. It is NULLABLE and there is deliberately
-- no foreign key: a meeting held in a room nobody curated has a room_id and no
-- curation row, and a key would refuse exactly the write that makes the tracker
-- complete. Same reasoning as review_participants.review_id below.
--
-- `revision_ids` is the set of model_revisions rows that were VISIBLE when the
-- meeting ended — "what was on screen". An array rather than one id because a
-- review can show a product beside a mating part, and Compare shows two
-- revisions of one line at once. Empty for a meeting with no stored revisions,
-- which is every meeting recorded before this column existed.
alter table tracker_sessions
  add column if not exists review_id text;
alter table tracker_sessions
  add column if not exists revision_ids uuid[] not null default '{}';

create index if not exists tracker_sessions_review_idx
  on tracker_sessions (review_id, ended_at desc);

-- Tracker items (one per InsightCard)
create table if not exists tracker_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references tracker_sessions(id) on delete cascade,
  type text not null check (type in ('RISK', 'RATIONALE', 'ACTION')),
  title text not null,
  description text not null default '',
  priority text not null default 'Medium' check (priority in ('Critical', 'High', 'Medium', 'Low')),
  status text not null default 'Open' check (status in ('Open', 'In Review', 'Approved', 'Rejected')),
  assignee text,
  due_date date,
  component_reference text,
  department text,
  agent_id text not null default '',
  source_message_ids text[],
  affected_requirement_ids text[],
  impact text,
  mitigation_strategy text,
  design_driver text,
  tradeoff_analysis text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A card belongs to a design review and to the revision it was raised on
-- (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md batch BC).
--
-- This is what makes the tracker able to say "raised on Rev A · still open on
-- Rev C" instead of showing a flat list with no idea which version of the
-- product a risk was about. `raised_on_revision` is a model_revisions.id and is
-- nullable: a card from an ad-hoc session, from a review with no stored
-- revisions, or from before this column existed has nothing to point at, and
-- the tracker renders those without a revision line rather than dropping them.
--
-- `part_node_id` / `part_name` record the mesh a card was pointed at when it was
-- raised, which `component_reference` almost but not quite does: that one is
-- whatever the AI put in a free-text field, and it is only constrained to the
-- model tree's ids when the extraction was given one. These two are what the
-- app knew for certain.
--
-- `source` separates a card an agent wrote from one a person typed in the room
-- (batch BG). 'ai' is the default so every existing row reads as an agent's,
-- which is what it is. `created_by_name` is the display name behind a 'manual'
-- card and stays NULL for an agent's — the agent is already named by agent_id.
alter table tracker_items
  add column if not exists review_id text;
alter table tracker_items
  add column if not exists raised_on_revision uuid;
alter table tracker_items
  add column if not exists part_node_id text;
alter table tracker_items
  add column if not exists part_name text;
alter table tracker_items
  add column if not exists created_by_name text;
alter table tracker_items
  add column if not exists source text not null default 'ai'
    check (source in ('ai', 'manual'));

create index if not exists tracker_items_review_idx on tracker_items (review_id);
create index if not exists tracker_items_revision_idx on tracker_items (raised_on_revision);

-- Comments on items
create table if not exists tracker_comments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references tracker_items(id) on delete cascade,
  author_name text not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- Status history (audit trail)
create table if not exists tracker_status_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references tracker_items(id) on delete cascade,
  status text not null,
  changed_by text not null default 'user',
  note text,
  created_at timestamptz not null default now()
);

-- Auto-update updated_at on tracker_items
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tracker_items_updated_at on tracker_items;
create trigger tracker_items_updated_at
  before update on tracker_items
  for each row execute function update_updated_at();

-- Enable Row Level Security (open read/write for now — lock down later with auth)
alter table tracker_sessions enable row level security;
alter table tracker_items enable row level security;
alter table tracker_comments enable row level security;
alter table tracker_status_history enable row level security;

drop policy if exists "public read sessions" on tracker_sessions;
drop policy if exists "public insert sessions" on tracker_sessions;
drop policy if exists "public update sessions" on tracker_sessions;
create policy "public read sessions"   on tracker_sessions for select using (true);
create policy "public insert sessions" on tracker_sessions for insert with check (true);
create policy "public update sessions" on tracker_sessions for update using (true);

drop policy if exists "public read items" on tracker_items;
drop policy if exists "public insert items" on tracker_items;
drop policy if exists "public update items" on tracker_items;
drop policy if exists "public delete items" on tracker_items;
create policy "public read items"   on tracker_items for select using (true);
create policy "public insert items" on tracker_items for insert with check (true);
create policy "public update items" on tracker_items for update using (true);
create policy "public delete items" on tracker_items for delete using (true);

drop policy if exists "public read comments" on tracker_comments;
drop policy if exists "public insert comments" on tracker_comments;
create policy "public read comments"   on tracker_comments for select using (true);
create policy "public insert comments" on tracker_comments for insert with check (true);

drop policy if exists "public read history" on tracker_status_history;
drop policy if exists "public insert history" on tracker_status_history;
create policy "public read history"   on tracker_status_history for select using (true);
create policy "public insert history" on tracker_status_history for insert with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Review curations (the pre-meeting curated content: title, description,
-- model, viewpoints, pins, agenda slides). Whole nested structure is stored
-- as jsonb to mirror the TypeScript ReviewDraft type. Multi-user editable;
-- the URL /review/:id/setup is the share key.
--
-- NOTE: imported GLB/OBJ files are NOT persisted server-side in v1 — only
-- the preset model TYPE survives across sessions. TODO: move imported files
-- to a Supabase Storage bucket ('review-models' with public read) and store
-- the file's URL instead of base64.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists review_curations (
  id text primary key,
  title text not null default 'Untitled Review',
  description text not null default '',
  asset jsonb not null default '{}'::jsonb,
  viewpoints jsonb not null default '[]'::jsonb,
  pins jsonb not null default '[]'::jsonb,
  agenda jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Requirements travel with the review (added 2026-09-22). A separate column
-- rather than a field inside another blob, so PostgREST selects it like the
-- rest. Idempotent: install.sh re-applies this file on every run, which is
-- how an existing install gets the column.
alter table review_curations
  add column if not exists requirements jsonb not null default '[]'::jsonb;

-- Team roster travels with the review (added 2026-09-22). People who can be
-- assigned to tracker items and insight cards. Idempotent like requirements.
alter table review_curations
  add column if not exists team jsonb not null default '[]'::jsonb;

-- User-defined label values (added 2026-09-23). Keys are field ids from
-- review_label_fields; values are free-text or chosen from the field's value
-- list. Stored on the review so the tracker can group by what the review
-- said at the time. Idempotent like requirements/team.
alter table review_curations
  add column if not exists labels jsonb not null default '{}'::jsonb;

-- Per-review visibility (added 2026-09-23). When false the review still
-- exists and the link still works, but it does not appear in the lobby's
-- Saved Reviews list. Default true so every existing review keeps behaving
-- exactly as before. Idempotent like the other add-column blocks.
alter table review_curations
  add column if not exists listed boolean not null default true;

-- Who owns this design review, and whether it has been put away
-- (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md batch BC).
--
-- `owner_id` is a GoTrue account id. NULLABLE, and NULL for every review that
-- existed before accounts did: those were created on an install with no
-- identity, so there is nobody to name. lib/reviews/roles.ts reads a NULL owner
-- as "unclaimed" and treats this install's admins as owners of it, and the admin
-- console's claim action (batch BH) is what fills the column in.
--
-- `archived` is the admin console's "put this away" (batch BE). Default false so
-- every existing review keeps appearing exactly where it does today.
alter table review_curations
  add column if not exists owner_id uuid;
alter table review_curations
  add column if not exists archived boolean not null default false;

-- A picture of the review's own 3D scene (added 2026-09-25,
-- docs/plan/15-sessions-and-variants.md batch BO).
--
-- A small JPEG data URL — no larger than 480x270 and about 60 KB of base64 —
-- captured in the room from its WebGL canvas, and read back by the lobby's
-- review cards and its preview so a list of reviews shows the scenes they are
-- about instead of a row of identical placeholders. lib/reviews/thumbnail.ts
-- holds both limits and refuses to write a capture that comes out bigger, so
-- this column cannot quietly become where a megabyte-per-review image
-- collection lives.
--
-- NULLABLE and with no default, which is what makes it free to apply: every
-- review that already exists keeps its row exactly as it was, and an install
-- that has not re-applied this file since batch BO simply has no thumbnails.
-- Idempotent like the blocks above it, because install.sh re-applies this whole
-- file on every run and an upgrade is exactly a second run of it.
alter table review_curations
  add column if not exists thumbnail text;

create index if not exists review_curations_updated_at_idx
  on review_curations (updated_at desc);

drop trigger if exists review_curations_updated_at on review_curations;
create trigger review_curations_updated_at
  before update on review_curations
  for each row execute function update_updated_at();

alter table review_curations enable row level security;

-- DELETE has no policy (removed 2026-09-25, docs/plan/15-sessions-and-variants.md
-- batch BN), and the drop above is what takes the old one away on an upgrade:
-- install.sh re-applies this whole file on every run, so a policy that is dropped
-- here and never re-created is gone from every install that has been upgraded.
--
-- Deleting a design review is not one row. It is the review's meetings, the cards
-- raised in them and their status history, its lines, its roster and its stored
-- revisions, and those have to agree with each other — half of it is worse than
-- none, because a review whose curation row is gone leaves sessions and cards in
-- the tracker that no review can be opened on. So the delete is
-- `delete_review(p_review)` further down this file, called by api/reviews/delete.ts
-- with the service role, which is also where the caller's role is checked. The
-- revoke after the table-wide grant below is the second mechanism, the way
-- review_lines' is.
drop policy if exists "public read curations" on review_curations;
drop policy if exists "public insert curations" on review_curations;
drop policy if exists "public update curations" on review_curations;
drop policy if exists "public delete curations" on review_curations;
create policy "public read curations"   on review_curations for select using (true);
create policy "public insert curations" on review_curations for insert with check (true);
create policy "public update curations" on review_curations for update using (true);

-- Enable Supabase Realtime so multiple curators editing the same review see
-- each other's changes live (used by the setup page to merge concurrent
-- contributions before the meeting). Wrapped in a DO block to ignore the
-- "already member of publication" error on re-runs.
do $$
begin
  alter publication supabase_realtime add table review_curations;
-- duplicate_object: already a member (a re-run). undefined_object: plain
-- Postgres has no supabase_realtime publication; the schema is complete anyway.
exception when duplicate_object or undefined_object then null;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Label fields (added 2026-09-23). User-defined grouping dimensions: one team
-- groups by Product → Variant → Phase, another by Programme → Gate. The app
-- ships suggested fields and lets people change them. values text[] is empty
-- when the field is free-text.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists review_label_fields (
  id text primary key,
  name text not null,
  position int not null default 0,
  values text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table review_label_fields enable row level security;

drop policy if exists "public read label fields" on review_label_fields;
drop policy if exists "public insert label fields" on review_label_fields;
drop policy if exists "public update label fields" on review_label_fields;
drop policy if exists "public delete label fields" on review_label_fields;
create policy "public read label fields"   on review_label_fields for select using (true);
create policy "public insert label fields" on review_label_fields for insert with check (true);
create policy "public update label fields" on review_label_fields for update using (true);
create policy "public delete label fields" on review_label_fields for delete using (true);

-- NOT SEEDED. The fields are the user's own vocabulary (user, 2026-09-23:
-- "the labels should be set by the user, not pre filled"), so the table
-- starts empty and the tracker's "Label fields" screen is where they are
-- created. Shipping Product/Variant/Phase made our guess look like a rule.

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit events (added 2026-09-23). A minimal log of grants: who admitted whom,
-- who declined whom, and who changed the join policy. Written by the room
-- server (party/room.server.ts), read by the admin screen (lib/auditRepo.ts).
--
-- This is NOT a tamper-proof ledger. Names are self-asserted — the log records
-- what the server saw happen, described in those terms. A design review's
-- contents are commercially sensitive; silent grants are not acceptable, and
-- this is the minimum record that makes them visible.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null,
  room_id text not null,
  actor_name text not null default '',
  actor_id text not null default '',
  subject_name text not null default '',
  subject_id text not null default '',
  detail text not null default ''
);

create index if not exists audit_events_at_idx on audit_events (at desc);

alter table audit_events enable row level security;

-- RLS policies matching the rest of this schema: there is no identity to key
-- on (no accounts, names are self-asserted), so the policies are open. The
-- database is reachable only through the app's origin, and the front-door
-- password is what guards that origin.
drop policy if exists "public read audit events" on audit_events;
drop policy if exists "public insert audit events" on audit_events;
create policy "public read audit events"   on audit_events for select using (true);
create policy "public insert audit events" on audit_events for insert with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Review participants (added 2026-09-24, docs/plan/13-identity.md batch AZ).
-- "The reviews I have been part of": one row per person per room, written when
-- a SIGNED-IN person is admitted to a room (lib/reviewParticipantsRepo.ts,
-- called from pages/RoomPage.tsx) and read back by the lobby's "Your reviews".
--
-- review_id is the room id, which for a curated review IS review_curations.id.
-- There is deliberately NO foreign key to it: an ad-hoc session has a room id
-- and no curation row, and a key would refuse exactly the write that makes the
-- list useful. The lobby joins by id with a second query and falls back to
-- "Session <short id>" when there is no curation.
--
-- Unlike every other table here, this one is NOT open. user_id defaults to
-- auth.uid() and each policy compares against auth.uid(), so a caller can write
-- and read only their own rows — who took part in a commercially sensitive
-- design review is nobody else's business, and the anon key the browser bundle
-- carries has no auth.uid() and so can read nothing here at all. A deployment
-- on identity.mode 'none' has no signed-in callers and never writes a row.
--
-- That this loads on a default install (identity profile OFF) is not an
-- assumption: the `auth` schema, the auth.uid() helper and the `authenticated`
-- role all come from the supabase/postgres image's own init-scripts, which
-- docker-compose.yml documents as running BEFORE the migrations/ directory
-- this file is mounted into. GoTrue adds tables inside `auth` at run time; it
-- is not what provides the schema (see deploy/db/auth-init.sql, which creates
-- nothing and only re-owns and re-grants what the image already made).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists review_participants (
  review_id text not null,
  user_id uuid not null default auth.uid(),
  role text not null default 'participant' check (role in ('host', 'participant')),
  first_joined_at timestamptz not null default now(),
  last_joined_at timestamptz not null default now(),
  primary key (review_id, user_id)
);

-- The only read is "my rows, newest first", which RLS has already narrowed to
-- one user_id.
create index if not exists review_participants_user_idx
  on review_participants (user_id, last_joined_at desc);

alter table review_participants enable row level security;

-- `authenticated` only, and no delete policy: a participant row is a record,
-- not something the app ever removes. The update policy's USING doubles as its
-- WITH CHECK (Postgres applies the same expression to both), so a row can be
-- bumped — last_joined_at, or a role upgraded to 'host' — but never moved to
-- another user_id.
drop policy if exists "own review participants select" on review_participants;
drop policy if exists "own review participants insert" on review_participants;
drop policy if exists "own review participants update" on review_participants;
create policy "own review participants select" on review_participants
  for select to authenticated using (user_id = auth.uid());
create policy "own review participants insert" on review_participants
  for insert to authenticated with check (user_id = auth.uid());
create policy "own review participants update" on review_participants
  for update to authenticated using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- Design review members (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md
-- batch BC). One row per SIGNED-IN account per design review, with the role that
-- account holds in it. This is the table lib/reviews/roles.ts's resolveRole
-- reads, and the one the room server reads to decide whether a scene change is
-- this person's to make.
--
-- Distinct from review_participants, which is "the reviews I have been part of"
-- — a record of attendance, keyed on the person, that they alone can read. This
-- one is the review's own roster: who is allowed to do what in it, which every
-- participant's screen has to be able to render (the People tab, the "Robin is
-- editing the review" line in batch BH) and which the room server has to be able
-- to read with the anon key it holds.
--
-- Guests are never members. There is nothing to key a row on: a guest has no
-- account, and a row keyed on a self-asserted name would be a permission granted
-- to whoever typed it. resolveRole answers 'guest' for them instead, which
-- lib/reviews/roles.ts's can() keeps out of addCard and everything above it.
--
-- 'owner' is a role here as well as review_curations.owner_id, so the roster a
-- screen renders and the column an ownership transfer writes cannot disagree:
-- transferring ownership writes both.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists review_members (
  review_id text not null,
  user_id uuid not null,
  role text not null default 'participant'
    check (role in ('owner', 'editor', 'participant')),
  added_at timestamptz not null default now(),
  added_by uuid,
  primary key (review_id, user_id)
);

create index if not exists review_members_user_idx on review_members (user_id);

alter table review_members enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Model revisions (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md
-- batch BC). Every version of every model line a design review has ever shown.
--
-- The FILE is not here. `hash` is the SHA-256 batch BA stored it under, and
-- /api/models/<hash> serves the bytes; this row is the review's record that it
-- showed that file, as that revision of that line, on that date, put there by
-- that person. Small enough to read on every open, which is what lets a review
-- rebuild its scene from history instead of from the single model its curation
-- row happens to name.
--
-- `unique (review_id, line, revision)` is the whole point of the table: two
-- uploads into the same review cannot both be Rev B of the bracket. The letter
-- is computed by lib/scene/roomScene.nextRevisionFor from the line's newest, so
-- the constraint is what catches two people importing at the same moment — the
-- second insert fails and the importer is told to try again rather than silently
-- overwriting the first one's history.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists model_revisions (
  id uuid primary key default gen_random_uuid(),
  review_id text not null,
  line text not null,
  revision text not null,
  hash text not null,
  file_name text not null default '',
  size bigint not null default 0,
  notes text not null default '',
  uploaded_by uuid,
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now(),
  unique (review_id, line, revision)
);

create index if not exists model_revisions_review_idx
  on model_revisions (review_id, created_at);
create index if not exists model_revisions_hash_idx on model_revisions (hash);

alter table model_revisions enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the two tables above.
--
-- READ is open to anon and authenticated for any review, and has to be: a
-- participant's screen renders the model tree and the People tab from these two
-- tables, and on a deployment whose identity.mode is 'none' that screen holds
-- only the anon key. This is also what the room server reads to work out a
-- signed-in person's role — it has the anon key and nothing else.
--
-- WRITE is open too, which is the part worth saying plainly:
--
--   ROLE ENFORCEMENT IS IN THE APP AND IN THE ROOM SERVER, NOT HERE.
--   lib/reviews/roles.ts decides who may add a revision, manage people or edit
--   the review, and party/room.server.ts refuses a scene change from somebody
--   whose role does not allow it. The database does not check any of that yet.
--   Locking these tables down per role is a LATER HARDENING STEP, and it cannot
--   be done by copying the policies above: it needs a SECURITY DEFINER helper
--   that answers "what role does auth.uid() hold in this review", which only
--   means anything on a deployment with accounts at all.
--
-- The reason it is open rather than denied is the same reason every other table
-- in this file is open: a `mode: 'none'` install — the default self-hosted one —
-- has no signed-in callers, so an auth.uid()-keyed policy would refuse the only
-- writes that ever happen and the app would not work at all. What guards such an
-- install is the front-door password on the origin, exactly as it does for
-- review_curations and tracker_items.
-- ─────────────────────────────────────────────────────────────────────────────
-- Membership decides who may edit a review and run its meetings, and the room
-- server reads it with the public anon key. So it is readable by everyone but
-- writable only narrowly: a signed-in person may add THEMSELVES as owner of a
-- review they already own (the row ensureReviewOwner writes on creation).
-- Adding editors and participants goes through the api with the service role
-- (the People tab, batch BH). Open write policies here would let anyone holding
-- the public key make themselves owner or editor of any review.
drop policy if exists "public read review members" on review_members;
drop policy if exists "public insert review members" on review_members;
drop policy if exists "public update review members" on review_members;
drop policy if exists "public delete review members" on review_members;
drop policy if exists "owner adds themselves" on review_members;
drop policy if exists "owner updates own row" on review_members;
create policy "public read review members" on review_members for select using (true);
create policy "owner adds themselves" on review_members for insert to authenticated
  with check (
    user_id = auth.uid() and role = 'owner'
    and exists (select 1 from review_curations c where c.id = review_id and c.owner_id = auth.uid())
  );
create policy "owner updates own row" on review_members for update to authenticated
  using (user_id = auth.uid() and role = 'owner')
  with check (
    user_id = auth.uid() and role = 'owner'
    and exists (select 1 from review_curations c where c.id = review_id and c.owner_id = auth.uid())
  );

-- review_curations stays open to the anon key (a 'none' install writes it that
-- way), so its owner_id needs its own guard: through the public API it can be
-- set only to yourself, only while it is still empty, and never changed after.
-- The service role and database administrators are not restricted.
create or replace function guard_review_owner() returns trigger
language plpgsql as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.owner_id is not null and new.owner_id is distinct from auth.uid() then
      raise exception 'a design review''s owner can only be the person creating it'
        using errcode = '42501';
    end if;
  elsif new.owner_id is distinct from old.owner_id then
    if old.owner_id is null and new.owner_id = auth.uid() then
      return new;
    end if;
    raise exception 'the owner of a design review cannot be changed here'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists review_curations_guard_owner on review_curations;
create trigger review_curations_guard_owner
  before insert or update on review_curations
  for each row execute function guard_review_owner();

drop policy if exists "public read model revisions" on model_revisions;
drop policy if exists "public insert model revisions" on model_revisions;
drop policy if exists "public update model revisions" on model_revisions;
create policy "public read model revisions"   on model_revisions for select using (true);
create policy "public insert model revisions" on model_revisions for insert with check (true);
create policy "public update model revisions" on model_revisions for update using (true);
-- No delete policy: a revision is the review's history, and the admin console's
-- "delete a revision" (batch BE) runs through the api with a service-role token,
-- which has BYPASSRLS and does not need one.

-- ─────────────────────────────────────────────────────────────────────────────
-- Lines of a design review (added 2026-09-25, docs/plan/15-sessions-and-variants.md
-- batch BK). A design review is the lasting thing; inside it a LINE is a
-- continuous run of meetings, and a session belongs to one.
--
-- Every review has exactly one MAIN line — the meetings everybody means when they
-- say "the review met on Tuesday" — and may have VARIANTS: a named side line
-- started from one of the main line's sessions, to try a different answer without
-- losing the one the main line is holding. `parent_session_id` is that session,
-- and it is what the session map draws the variant leaving from.
--
-- On screen these are "Main line" and "Variant A". The words branch, fork, merge
-- and commit never appear: the people using this are hardware engineers and the
-- plan is explicit that the programming metaphor must not show through.
--
-- `letter` is a variant's A, B, C … and is NULL for the main line, which needs no
-- letter because there is only ever one of it. It is part of
-- `unique (review_id, kind, letter)` so two variants of one review cannot both be
-- Variant A, and it is the suffix of a variant's live room name
-- (`<reviewId>~<letter>`, lib/reviews/lines.partyRoomName) — which is why it is
-- assigned once and never reused, even after the variant is dropped.
--
-- `status` is the variant's fate: 'active' while it is being explored, 'adopted'
-- when its model and cards have been taken into the main line, 'dropped' when it
-- was not. Both are kept for the record rather than deleted — a dropped variant is
-- an answer the review tried and rejected, and that is worth seeing on the map.
-- `closed_at` is when it became one or the other. Batch BK only ever writes
-- 'active'; adopting and dropping are batch BL, and both go through
-- api/reviews/lines.ts rather than through the browser — see the row level
-- security below.
--
-- `adopted_revision_ids` is what the main line's scene became when this variant
-- was adopted into it, as model_revisions ids: the variant's own newest
-- revisions where only the variant had moved, and, where BOTH lines had uploaded
-- a new revision of the same model, the ones the person adopting chose in answer
-- to the one question api/reviews/lines.ts asks. It is a column on the VARIANT
-- and not on the main line, so the main line's own scene is still derived from
-- its last meeting: lib/reviews/linesRepo.originRevisionIds takes the adoption
-- only while it is NEWER than that meeting, and a meeting held after it
-- supersedes it without anything having to be written here again.
--
-- review_id has deliberately NO foreign key, for the same reason
-- tracker_sessions.review_id has none: a line belongs to a review by id, and a
-- key would refuse the write for any room that has no curation row.
--
-- `parent_line_id` and `merged_into_line_id` (added 2026-09-26, batch BX) are the
-- two halves of a variant's own story, and both DO have keys — to this same table,
-- because both name a line of the same review and a line that does not exist is not
-- a parent or a destination anybody can open. `parent_line_id` is where it was
-- started from, which until batch BX could only ever be the main line and was
-- therefore derivable from `parent_session_id`; from batch BX a variant can be
-- explored from another variant, and the moment one is explored from a variant that
-- has never met there is no session to derive it from at all.
-- `merged_into_line_id` is where it went, and it is a column rather than a
-- derivation because 'adopted' used to mean exactly one thing — taken into the main
-- line — and now means "taken into the line named here". Both are NULL on every row
-- written before this batch, and the backfill below fills in what those rows can be
-- known to have meant.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists review_lines (
  id uuid primary key default gen_random_uuid(),
  review_id text not null,
  kind text not null check (kind in ('main', 'variant')),
  name text not null default '',
  letter text,
  parent_session_id uuid references tracker_sessions(id),
  parent_line_id uuid references review_lines(id),
  status text not null default 'active' check (status in ('active', 'adopted', 'dropped')),
  created_by uuid,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  merged_into_line_id uuid references review_lines(id),
  drop_reason text,
  adopted_revision_ids uuid[],
  unique (review_id, kind, letter)
);

-- For an install that applied this file at batch BK and is being upgraded: the
-- column the two functions below write, added only where it is missing.
alter table review_lines
  add column if not exists adopted_revision_ids uuid[];

-- The same, for the two batch BX added: where a variant was started from, and
-- where it was merged into. Both nullable, both keyed to this table, and both left
-- NULL on a row this file has already written — the backfill further down fills in
-- what a pre-BX row can be known to have meant, and a variant whose parent cannot
-- be worked out keeps NULL, which every reader answers as "from the main line"
-- because that is the only place a variant could be started from before this batch.
alter table review_lines
  add column if not exists parent_line_id uuid references review_lines(id);
alter table review_lines
  add column if not exists merged_into_line_id uuid references review_lines(id);
-- Why a dropped variant was dropped. It was already stored — word for word, on every
-- card the drop closed, as tracker_items.closed_reason — but a card's reason is only
-- findable by reading that review's cards, and the room that opens on a dropped line
-- has to say it in a banner before it has read anything but its own line row.
alter table review_lines
  add column if not exists drop_reason text;

create index if not exists review_lines_parent_idx
  on review_lines (parent_line_id) where parent_line_id is not null;

-- Exactly one main line per design review. A partial index rather than a column
-- constraint because `unique (review_id, kind, letter)` cannot express it: the
-- main line's letter is NULL, and two NULLs are distinct to a unique constraint,
-- so without this nothing would stop a second main line appearing.
create unique index if not exists review_lines_one_main_per_review
  on review_lines (review_id) where kind = 'main';

create index if not exists review_lines_review_idx
  on review_lines (review_id, created_at);

alter table review_lines enable row level security;

-- WHO MAY WRITE A LINE (tightened 2026-09-25, docs/plan/15-sessions-and-variants.md
-- batch BL). Batch BK copied model_revisions here — open read, open insert, open
-- update — because the only write the browser made was `ensureMainLine`, and a
-- main line is a fact about a review rather than a decision anybody could gain
-- from making. Batch BL adds three writes that ARE decisions: starting a variant,
-- adopting one into the main line and dropping one. Each of them moves other
-- people's rows with it (adopting re-homes every card the variant raised, dropping
-- closes them), and each is limited to the review's owners and editors by
-- lib/reviews/roles.ts — a rule that cannot live here, because a `mode: 'none'`
-- install has no signed-in callers and an auth.uid()-keyed policy would refuse
-- every write on the deployment most people run.
--
-- So the browser keeps exactly the write it needs and loses the rest:
--
--   SELECT  open. The map, the tracker's line filter and the room's own chip all
--           read lines, and a line row is a label and a date, not a secret.
--   INSERT  `kind = 'main'` ONLY. That is lib/reviews/linesRepo.ensureMainLine,
--           which has to work from the browser because a room writes it on open,
--           before any meeting has been recorded. Creating a variant is NOT here:
--           it goes through api/reviews/lines.ts, which holds the service role and
--           checks the caller's role the way api/reviews/members.ts does.
--   UPDATE  no policy at all, so every update is refused. Adopting and dropping
--           are the two functions further down this file, called by the api.
--   DELETE  no policy at all. A line is the review's history; it is dropped or
--           adopted, never removed, so that a card can keep saying where it came
--           from.
--
-- EVERY STATEMENT IS SAFE TO RUN TWICE: the drops are `if exists`, and the two
-- policies batch BK created are dropped here and never re-created, so re-applying
-- this file on an upgrade is what takes the old permissions away.
drop policy if exists "public read review lines" on review_lines;
drop policy if exists "public insert review lines" on review_lines;
drop policy if exists "public update review lines" on review_lines;
drop policy if exists "public insert main review line" on review_lines;
create policy "public read review lines"       on review_lines for select using (true);
create policy "public insert main review line" on review_lines for insert with check (kind = 'main');

-- Which line a meeting belongs to, and which number it is on that line
-- (added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BK).
--
-- `seq` is the number in the label the map and the tracker show: S1, S2, S3 on
-- the main line, A1, A2 on Variant A. Stored rather than derived from
-- `row_number() over (order by ended_at)` because a line's meetings are numbered
-- by the order they happened in and two of them can end inside the same second —
-- and because a session that is later deleted must not renumber the ones after
-- it, which would silently change what every card raised in them says.
--
-- Both NULLABLE: a meeting recorded before this column existed has no line until
-- the backfill below gives it one, and a meeting held in a room nobody curated
-- (review_id NULL) never gets one at all. lib/reviews/lines.sessionLabel answers
-- null for a session with no seq, and the tracker then renders the card without a
-- line rather than inventing "S0".
alter table tracker_sessions
  add column if not exists line_id uuid;
alter table tracker_sessions
  add column if not exists seq int;

create index if not exists tracker_sessions_line_idx
  on tracker_sessions (line_id, seq);

-- Who attended a meeting, and the minutes of it
-- (added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BM).
--
-- `attendee_names` is the same people `participant_count` counts, by name, in the
-- order the room knew them: the person who ended the meeting first, then everybody
-- else in it. Two columns rather than one because they answer two different
-- questions and because a meeting recorded before this column existed has a count
-- and no names — the session map's panel shows the names when there are any and
-- falls back to "6 people" when there are not, so an old row still reads.
--
-- `summary` is the markdown api/capture/summary.ts writes for the meeting, stored
-- on the meeting's own row by the one browser that recorded it. NULL is the normal
-- state and not a failure: a meeting with no transcript and no cards, a room in
-- privacy mode, capture paused while somebody curated the review, and any provider
-- failure all leave it NULL, and the panel then says that no summary was stored.
-- It is written by an UPDATE after the row exists, never by the INSERT, so a
-- meeting is recorded even when its minutes are not.
alter table tracker_sessions
  add column if not exists attendee_names text[];
alter table tracker_sessions
  add column if not exists summary text;

-- The transcript of the meeting, when the meeting asked for one to be kept
-- (added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BU).
--
-- Stopping a recording used to mean one thing — the audio went off for card
-- extraction — and a person who only wanted what was said had no way to say so.
-- It is three choices now, and this column is one of them: "Save transcript with
-- this meeting". The other two are the cards (which land in tracker_items as they
-- always did) and a .txt downloaded straight from the browser, which is never
-- stored anywhere.
--
-- AN ARRAY OF ROWS, not the text of the transcript, because the two things a
-- transcript can hold are not the same shape: what somebody said, and where
-- somebody was pointing while they said it.
--
--   {"t": 4000, "speaker": "Olga Owner", "text": "Let's look at the hinge pin."}
--   {"t": 7000, "speaker": "Olga Owner", "pointing": "Hinge pin", "untilMs": 12000}
--
-- `t` and `untilMs` are milliseconds into the recording, which is what makes a
-- line findable in a player's scrub bar; the pointing rows are only there when
-- "include what people pointed at" was asked for, and both kinds are sorted by
-- `t`. A transcript that hit its cap ends with `{"truncated": true}` — a marker
-- rather than a silently dropped tail, so lib/capture/transcriptText.ts can tell
-- the reader the meeting went on and the record did not.
--
-- jsonb and not text, for the reason every other structured column here has: this
-- file is the schema, and there is no migration to add a table type later.
--
-- CAPPED BY THE WRITER at 20 000 rows and 2 MB of JSON (lib/capture/transcript),
-- because a column with no bound is a table that eventually cannot be listed — and
-- this one is read by the session map's panel and by the lobby's preview, neither
-- of which wants a megabyte of a meeting it is drawing a dot for. Both readers ask
-- for it for ONE selected session and never in a list query, for the same reason.
--
-- NULL is the normal state and not a failure: every meeting held before this
-- column existed, every meeting whose recording nobody asked to keep, every room
-- in privacy mode, and every meeting recorded while capture was paused all leave
-- it NULL, and the session panel then shows no transcript row at all.
alter table tracker_sessions
  add column if not exists transcript jsonb;

-- Which line a card belongs to, and which one it was raised on
-- (added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BK).
--
-- Two columns because they come apart, and the moment they do is the whole point
-- of a variant. `line_id` is the line the card is ON now — where a reviewer
-- looking at the main line finds it. `origin_line_id` is the line it was RAISED
-- on, and never changes: adopting a variant into the main line (batch BL) moves
-- the card's line_id and leaves its origin alone, which is what lets the tracker
-- say "Raised in Variant A · adopted 12 Oct" instead of quietly rewriting where a
-- risk came from.
--
-- `adopted_at` is that moment, and `closed_reason` is why a card that is closed is
-- closed when the reason is not one of the four statuses — "dropped with the
-- variant" being the one batch BL writes. Both nullable and both unused in BK.
alter table tracker_items
  add column if not exists line_id uuid;
alter table tracker_items
  add column if not exists origin_line_id uuid;
alter table tracker_items
  add column if not exists adopted_at timestamptz;
alter table tracker_items
  add column if not exists closed_reason text;

create index if not exists tracker_items_line_idx on tracker_items (line_id);

-- ─── Backfill: give every review that has met a main line ────────────────────
--
-- A design review that existed before this batch has sessions and cards and no
-- line, and the moment it is opened the map, the tracker's line filter and the
-- "carried over" group all ask which line those meetings are on. So the answer is
-- written here, once, for every review that has met: its sessions and their cards
-- join a main line, numbered in the order they happened.
--
-- EVERY STATEMENT BELOW IS SAFE TO RUN TWICE, because install.sh re-applies this
-- whole file on every run and an upgrade is exactly a re-run. Each one is keyed on
-- "is still missing" (NOT EXISTS, `is null`) rather than on "has this run before",
-- and the insert conflicts with review_lines_one_main_per_review and does nothing
-- — so a second run adds no line, renumbers no session, and never overwrites a
-- line or an origin that batch BL has since moved.
insert into review_lines (review_id, kind, name, letter, status, created_at)
select s.review_id, 'main', 'Main line', null, 'active', min(s.ended_at)
from tracker_sessions s
where s.review_id is not null
  and not exists (
    select 1 from review_lines l where l.review_id = s.review_id and l.kind = 'main'
  )
group by s.review_id
on conflict do nothing;

update tracker_sessions s
set line_id = l.id
from review_lines l
where l.kind = 'main'
  and l.review_id = s.review_id
  and s.line_id is null;

with numbered as (
  select s.id, row_number() over (partition by s.line_id order by s.ended_at, s.id) as n
  from tracker_sessions s
  where s.line_id is not null
)
update tracker_sessions s
set seq = numbered.n
from numbered
where s.id = numbered.id
  and s.seq is null;

-- The card's line is its meeting's line. origin_line_id is set from the same row
-- and is the one that stays: coalesce rather than assignment, so a card BL has
-- already adopted into the main line keeps the variant it was raised on.
update tracker_items i
set line_id = coalesce(i.line_id, s.line_id),
    origin_line_id = coalesce(i.origin_line_id, s.line_id)
from tracker_sessions s
where s.id = i.session_id
  and s.line_id is not null
  and (i.line_id is null or i.origin_line_id is null);

-- ─── Backfill: where every variant that already exists was started from ──────
--
-- Added 2026-09-26, docs/plan/15-sessions-and-variants.md batch BX. Every variant
-- written before `parent_line_id` existed was started from a meeting of the review's
-- MAIN line, because that was the only line a variant could leave from — so its
-- parent is that meeting's line where the meeting is still there, and the review's
-- main line where it is not (a meeting deleted since, which delete_review_session
-- refuses for exactly that reason and which only an old row can be). Keyed on
-- `is null`, so a second run adds nothing and never overwrites a parent batch BX has
-- since written.
update review_lines v
set parent_line_id = coalesce(
      (select s.line_id from tracker_sessions s where s.id = v.parent_session_id),
      (select m.id from review_lines m where m.review_id = v.review_id and m.kind = 'main')
    )
where v.kind = 'variant'
  and v.parent_line_id is null;

-- And where an already-adopted variant went. Until batch BX there was exactly one
-- answer — 'adopted' meant taken into the main line — so it is written rather than
-- asked for, and the map can draw the green return into the right row for a merge
-- that happened before the column existed.
update review_lines v
set merged_into_line_id = m.id
from review_lines m
where v.kind = 'variant'
  and v.status = 'adopted'
  and v.merged_into_line_id is null
  and m.review_id = v.review_id
  and m.kind = 'main';

-- ─── Adopting and dropping a variant ─────────────────────────────────────────
--
-- Added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BL. Two
-- functions, and the reason they are functions rather than two requests from
-- api/reviews/lines.ts is that each one writes several tables that have to agree
-- with each other:
--
--   adopt_review_line   moves every card the variant raised onto the line it is
--                       merged into, stamps each one with the moment it was merged,
--                       records what that line's scene became, makes the positions
--                       the variant left its models at that line's own, re-parents
--                       the variant's own active variants onto it, and marks the
--                       variant adopted — all of it or none of it.
--   drop_review_line    marks the variant dropped, closes every card still open on
--                       it with the reason, and writes the same status history the
--                       tracker writes when somebody closes a card by hand, so
--                       lib/trackerContinuity can still say WHEN it closed. It
--                       refuses while the variant has one of its own still being
--                       explored.
--
-- Half of either is worse than neither. A variant whose cards have moved but whose
-- status is still 'active' can be adopted a second time and move them again; a
-- dropped variant with open cards leaves risks sitting on a line nobody will ever
-- meet on, which is the one thing "kept for the record" is not supposed to mean.
--
-- BOTH ARE `security definer` AND EXECUTABLE BY THE SERVICE ROLE ALONE (the
-- revokes are immediately below). The published anon key can still read every row
-- of review_lines and cannot adopt or drop one, and cannot update a line at all —
-- which is what makes the role check in api/reviews/lines.ts the only thing that
-- decides who may do it, rather than one of two things that might.
--
-- `create or replace` and revokes/grants that are safe to repeat: install.sh
-- re-applies this whole file on every run, so an upgrade is exactly a second run
-- of it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function adopt_review_line(
  p_variant uuid,
  p_target uuid,
  p_revision_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant review_lines;
  v_target review_lines;
  v_walk review_lines;
  v_depth int;
  v_moved int;
  v_reparented int;
begin
  -- Locked, because two people merging the same variant at the same moment must
  -- produce one merge: the second one waits, then reads a row whose status is
  -- no longer 'active' and is told it has already been done.
  select * into v_variant from review_lines where id = p_variant for update;
  if not found or v_variant.kind <> 'variant' then
    return jsonb_build_object('ok', false, 'error', 'no_such_variant');
  end if;
  if v_variant.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'already_closed', 'status', v_variant.status);
  end if;

  -- The line being merged INTO, locked too: it is about to own every card the
  -- variant raised and every position the variant left a model at, and a target
  -- being dropped in another transaction at the same moment would leave those cards
  -- on a line nobody will ever meet on again.
  select * into v_target from review_lines where id = p_target for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_target_line');
  end if;
  -- Four refusals, and each is a fact about the pair rather than a preference:
  -- another review's line is not a destination anybody in this meeting can open; a
  -- closed one is a record and taking cards into it hides them; the variant itself
  -- would be a merge that moves nothing and closes the line; and one of its own
  -- descendants would make the descendant its own ancestor, so every card on both
  -- lines would end up on a line whose history runs in a circle.
  if v_target.review_id <> v_variant.review_id then
    return jsonb_build_object('ok', false, 'error', 'other_review');
  end if;
  if v_target.id = v_variant.id then
    return jsonb_build_object('ok', false, 'error', 'same_line');
  end if;
  if v_target.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'target_closed', 'status', v_target.status);
  end if;

  -- Up the target's own chain looking for the variant. A loop rather than a
  -- recursive CTE because plpgsql cannot `return` out of a query, and bounded
  -- because a chain with a loop in it is a row nobody should have written and must
  -- not hang the transaction that found it.
  v_walk := v_target;
  v_depth := 0;
  while v_walk.parent_line_id is not null and v_depth < 64 loop
    if v_walk.parent_line_id = v_variant.id then
      return jsonb_build_object('ok', false, 'error', 'own_descendant');
    end if;
    select * into v_walk from review_lines where id = v_walk.parent_line_id;
    if not found then
      exit;
    end if;
    v_depth := v_depth + 1;
  end loop;

  -- Every card the variant raised, open or not: a risk it found is a risk the target
  -- line now owns, and an already-closed one still has to say where it came from.
  -- origin_line_id is coalesced rather than left alone so a card that somehow never
  -- got one still ends up naming the variant, and never overwritten, so a card
  -- carried INTO the variant keeps the line it was raised on.
  update tracker_items
     set line_id = v_target.id,
         origin_line_id = coalesce(origin_line_id, v_variant.id),
         adopted_at = now(),
         updated_at = now()
   where line_id = v_variant.id;
  get diagnostics v_moved = row_count;

  -- Its own variants, still being explored, now hang off the line it went to
  -- (batch BX). Merging a variant that has variants of its own is allowed and this
  -- is what makes it safe: re-parented in the SAME transaction, so there is no
  -- moment in which an active line's parent is a closed one, and no variant left
  -- pointing at a line nobody can open. Closed children are left alone — their own
  -- parent_line_id is part of their record, and rewriting where a dropped variant
  -- came from would change what its cards say.
  update review_lines
     set parent_line_id = v_target.id
   where parent_line_id = v_variant.id
     and status = 'active';
  get diagnostics v_reparented = row_count;

  update review_lines
     set status = 'adopted',
         closed_at = now(),
         merged_into_line_id = v_target.id,
         adopted_revision_ids = p_revision_ids
   where id = v_variant.id;

  -- The variant's own saved positions become the target line's (added 2026-09-26,
  -- docs/plan/15-sessions-and-variants.md batch BV; the target line rather than
  -- always the main one, batch BX).
  --
  -- A review keeps where its models stand in its own row, because room storage is the
  -- room's and a review is opened again long after that room is gone: `asset.placements`
  -- is the MAIN line's and `asset.linePlacements[<review_lines.id>]` is one slot per
  -- variant, so exploring a variant cannot move another line's models. A merge is
  -- the moment two lines become one answer — the variant's model IS the target's model
  -- from here — so its positions go with it, and in the same transaction as the cards and
  -- the status: a merge that moved the cards and left the target standing where it was
  -- would open on the model the meeting had just decided against, arranged the way the
  -- meeting had just decided against.
  --
  -- Written only where the variant HAS a slot of its own. One that does not never
  -- diverged from the line it came from, so that line's slot already says where it
  -- stands and a write would be a no-op that still bumped `updated_at` and moved the
  -- review up the lobby's list. The slot is left in place either way, because it is the
  -- record of where the answer the review took had got to — and a DROP leaves its own
  -- there for the same reason, which is why drop_review_line has no counterpart of this
  -- statement.
  if exists (
    select 1 from review_curations
     where id = v_variant.review_id
       and asset -> 'linePlacements' ? v_variant.id::text
  ) then
    if v_target.kind = 'main' then
      update review_curations
         set asset = jsonb_set(
               asset,
               '{placements}',
               asset -> 'linePlacements' -> v_variant.id::text
             )
       where id = v_variant.review_id;
    else
      -- A variant target keeps its own slot and gets the merged one written into it,
      -- with `create_missing` so a target that has never moved a model — and so has no
      -- slot of its own yet — still ends up with one.
      update review_curations
         set asset = jsonb_set(
               asset,
               array['linePlacements', v_target.id::text],
               asset -> 'linePlacements' -> v_variant.id::text,
               true
             )
       where id = v_variant.review_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'moved', v_moved,
    'reparented', v_reparented,
    'targetLineId', v_target.id,
    'mainLineId', v_target.id,
    'variantId', v_variant.id,
    'letter', v_variant.letter
  );
end;
$$;

-- ─── The two-argument merge, kept so nothing already deployed breaks ──────────
--
-- Batch BX replaced `adopt_review_line(variant, revisions)` with the three-argument
-- one above, because a merge has a destination and the destination is no longer
-- always the main line. This is the old signature as a thin wrapper that answers the
-- only question the old signature could answer — "into the main line" — and then
-- delegates. It stays for two reasons: an install whose api bundle is older than its
-- schema would otherwise call a function that no longer exists, and `error:
-- 'no_main_line'` is a sentence api/reviews/lines.ts already translates.
--
-- It is NOT what the app calls. lib/reviews/linesClient.adoptVariant always names a
-- target, and the endpoint always passes one.
create or replace function adopt_review_line(
  p_variant uuid,
  p_revision_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant review_lines;
  v_main review_lines;
begin
  select * into v_variant from review_lines where id = p_variant;
  if not found or v_variant.kind <> 'variant' then
    return jsonb_build_object('ok', false, 'error', 'no_such_variant');
  end if;
  select * into v_main from review_lines
   where review_id = v_variant.review_id and kind = 'main';
  if not found then
    -- The api creates the main line before it calls this, so getting here means
    -- the review's lines are in a state nobody wrote on purpose. Refusing leaves the
    -- variant exactly as it was, which is the answer that can be retried.
    return jsonb_build_object('ok', false, 'error', 'no_main_line');
  end if;
  return adopt_review_line(p_variant, v_main.id, p_revision_ids);
end;
$$;

create or replace function drop_review_line(
  p_variant uuid,
  p_closed_reason text,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant review_lines;
  v_child review_lines;
  v_closed int;
begin
  select * into v_variant from review_lines where id = p_variant for update;
  if not found or v_variant.kind <> 'variant' then
    return jsonb_build_object('ok', false, 'error', 'no_such_variant');
  end if;
  if v_variant.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'already_closed', 'status', v_variant.status);
  end if;

  -- A variant of its own, still being explored (batch BX). Refused rather than
  -- repaired, and it is the simplest rule that is also the correct one: the child
  -- was started from THIS line's answer, and dropping the line leaves it starting
  -- from an answer the review has just rejected. Re-parenting it to the merge target
  -- is what `adopt_review_line` does and is right there, because a merge says the
  -- answer was taken; a drop says it was not, and there is then no line that is the
  -- honest parent. Which of the two should go is a decision about the child, and it
  -- belongs to the people exploring it — the same reason delete_review_session
  -- refuses a meeting a variant leaves from. Checked inside the transaction rather
  -- than only in the api, so two people dropping and exploring at the same moment
  -- cannot both be told they succeeded.
  select * into v_child from review_lines
   where parent_line_id = v_variant.id
     and status = 'active'
   order by created_at
   limit 1
   for update;
  if found then
    return jsonb_build_object(
      'ok', false,
      'error', 'has_active_children',
      'childId', v_child.id,
      'letter', v_child.letter,
      'name', v_child.name
    );
  end if;

  -- 'Open' and 'In Review' are the two the app has always meant by still open
  -- (lib/trackerContinuity.isClosed). A card already Approved or Rejected was
  -- dealt with by the people exploring the variant and is left exactly as they
  -- left it: rewriting a decision to 'Rejected because the variant was dropped'
  -- would say something about the engineering that nobody decided.
  with closing as (
    update tracker_items
       set status = 'Rejected',
           closed_reason = p_closed_reason,
           updated_at = now()
     where line_id = v_variant.id
       and status in ('Open', 'In Review')
    returning id
  )
  insert into tracker_status_history (item_id, status, changed_by, note)
  select closing.id, 'Rejected', coalesce(nullif(p_actor_name, ''), 'room'), p_closed_reason
    from closing;
  get diagnostics v_closed = row_count;

  update review_lines
     set status = 'dropped',
         closed_at = now(),
         -- The reason on the LINE as well as on every card it closes, so a room that
         -- opens on a dropped variant can say why in its banner without having read a
         -- single card. It is the same sentence the cards carry, not a copy of it made
         -- somewhere else: p_closed_reason is the one the endpoint built with
         -- lib/reviews/lines.droppedCardReason.
         drop_reason = p_closed_reason
   where id = v_variant.id;

  return jsonb_build_object(
    'ok', true,
    'closed', v_closed,
    'variantId', v_variant.id,
    'letter', v_variant.letter
  );
end;
$$;

-- The service role is the ONLY caller. `revoke … from public` matters because
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and the
-- table-level grants further down this file do not cover functions — so without
-- these lines the anon key the browser is built with could merge or drop any
-- variant of any review on the install. BOTH signatures of adopt_review_line are
-- listed, because a grant is per function and the two-argument wrapper above is a
-- function of its own: covering only the three-argument one would leave the old
-- signature callable by anybody, and it does the same write.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.adopt_review_line(uuid, uuid, uuid[]) from public, anon, authenticated;
    revoke all on function public.adopt_review_line(uuid, uuid[]) from public, anon, authenticated;
    revoke all on function public.drop_review_line(uuid, text, text) from public, anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.adopt_review_line(uuid, uuid, uuid[]) to service_role;
    grant execute on function public.adopt_review_line(uuid, uuid[]) to service_role;
    grant execute on function public.drop_review_line(uuid, text, text) to service_role;
  end if;
end $$;

-- ─── Deleting a design review, and deleting one of its sessions ─────────────
--
-- Added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BN. Two
-- functions for the same reason adopt and drop are functions: each one writes
-- several tables that have to agree with each other, and one call is one
-- transaction, which is what makes a half-delete impossible rather than merely
-- unlikely.
--
--   delete_review           everything the review is: the status history of its
--                           cards, its cards, its lines, its meetings, its
--                           roster, its stored revisions, and its own row.
--   delete_review_session   one meeting: its cards and their status history, and
--                           the meeting's own row.
--
-- THE ORDER OF THE DELETES IS THE POINT. review_lines.parent_session_id is a
-- foreign key to tracker_sessions(id), so a review's lines have to go before its
-- meetings or the delete is refused by the key and nothing is removed at all.
-- tracker_items and tracker_status_history both cascade, and are deleted
-- explicitly anyway: a delete that only works because of a cascade two tables
-- away is one that silently stops working when that cascade is edited.
--
-- STORED MODEL FILES ARE NOT DELETED, and cannot be from here. A file in model
-- storage is content-addressed — model_revisions.hash is its name — so the same
-- bytes can be the Rev B of two different reviews, and removing them for one
-- would break the other. The rows go; the files stay, exactly as they do for a
-- revision the admin console deletes.
--
-- SESSION NUMBERS ARE NOT REUSED AND NOT RENUMBERED. tracker_sessions.seq is left
-- alone, so a review that deletes S2 keeps an S1 and an S3: a card that says it
-- was raised in S3 must go on saying that, and renumbering would silently change
-- what every card raised after the deleted meeting claims about itself.
--
-- BOTH ARE `security definer` AND EXECUTABLE BY THE SERVICE ROLE ALONE (the
-- revokes are immediately below), the same pattern as adopt_review_line: EXECUTE
-- goes to PUBLIC by default on a new function and the table-level grants further
-- down this file do not cover functions, so without the revoke the published anon
-- key could delete any review on the install.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function delete_review(p_review text) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found boolean;
  v_items int;
  v_sessions int;
begin
  select exists (select 1 from review_curations where id = p_review) into v_found;
  if not v_found then
    return jsonb_build_object('ok', false, 'error', 'no_such_review');
  end if;

  select count(*) into v_items from tracker_items where review_id = p_review;
  select count(*) into v_sessions from tracker_sessions where review_id = p_review;

  delete from tracker_status_history
   where item_id in (select id from tracker_items where review_id = p_review);
  delete from tracker_items where review_id = p_review;
  -- Before the meetings, because review_lines.parent_session_id references them.
  delete from review_lines where review_id = p_review;
  delete from tracker_sessions where review_id = p_review;
  delete from review_members where review_id = p_review;
  delete from model_revisions where review_id = p_review;
  delete from review_curations where id = p_review;

  return jsonb_build_object('ok', true, 'items', v_items, 'sessions', v_sessions);
end;
$$;

create or replace function delete_review_session(p_session uuid) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_found boolean;
  v_items int;
  v_variant review_lines;
begin
  select exists (select 1 from tracker_sessions where id = p_session) into v_found;
  if not v_found then
    return jsonb_build_object('ok', false, 'error', 'no_such_session');
  end if;

  -- A variant leaves FROM this meeting, and the map draws its line starting at
  -- this stop. Refused rather than repaired: which of the two should go is a
  -- decision about the variant, and it belongs to the people exploring it. The
  -- api asks the same question first so that it can name the variant in the
  -- refusal; this check is the one that cannot be raced, because it is inside the
  -- same transaction as the delete.
  select * into v_variant from review_lines
   where parent_session_id = p_session
   order by created_at
   limit 1;
  if found then
    return jsonb_build_object(
      'ok', false,
      'error', 'variant_starts_here',
      'lineId', v_variant.id,
      'kind', v_variant.kind,
      'letter', v_variant.letter,
      'name', v_variant.name
    );
  end if;

  select count(*) into v_items from tracker_items where session_id = p_session;

  delete from tracker_status_history
   where item_id in (select id from tracker_items where session_id = p_session);
  delete from tracker_items where session_id = p_session;
  delete from tracker_sessions where id = p_session;

  return jsonb_build_object('ok', true, 'items', v_items);
end;
$$;

-- The service role is the ONLY caller, for the reason given above.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.delete_review(text) from public, anon, authenticated;
    revoke all on function public.delete_review_session(uuid) from public, anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.delete_review(text) to service_role;
    grant execute on function public.delete_review_session(uuid) to service_role;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Application settings (added 2026-09-24, docs/plan/14-rooms-models-admin-ai.md
-- batch BF). One row per setting, written from the admin console's AI section
-- and read back by the server-side AI router (lib/ai/settingsStore.ts).
--
-- `value` holds the non-secret half of a setting (which provider, which model,
-- an endpoint URL); `secret` holds the encrypted half (an API key, a webhook
-- header value) as the `v1:<iv>:<tag>:<ct>` string lib/ai/secretBox.ts writes.
-- The column is text rather than bytea so PostgREST can carry it as JSON and so
-- a dump of this table is still not a dump of the keys: the ciphertext is only
-- readable with a key derived from JWT_SECRET, which lives in the api
-- container's environment and not here.
--
-- THIS TABLE IS THE ONE EXCEPTION TO THE REST OF THIS FILE. Every other table
-- here is wide open on purpose — the app has no per-person identity to key a
-- policy on, and the front-door password guards the origin instead. This one
-- holds credentials, so RLS is enabled with NO POLICIES AT ALL, which in
-- Postgres means deny: the anon and authenticated roles — the two a browser's
-- Supabase key can select — get nothing, not even a row count. Only a request
-- carrying a service-role JWT reaches it, because that role has BYPASSRLS, and
-- only the api container can mint one (api/_lib/serviceRole.ts signs it with
-- JWT_SECRET, which never reaches a browser).
--
-- So the browser cannot read these settings, cannot write them, and cannot
-- discover that they exist. The admin console reaches them only through
-- /api/admin/ai, which is behind requireAdmin and which returns
-- { set: true, last4 } for a secret instead of the secret.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  secret text,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

alter table app_settings enable row level security;

-- No policies, and that is the point: see the block comment above. The drops
-- are here so a re-run of this file removes any policy an earlier version, or
-- a well-meaning `grant … to anon` added by hand, may have left behind. An
-- enabled RLS table with zero policies denies everything to every non-bypass
-- role, which is exactly what a credentials table wants.
do $$
declare
  policy_name text;
begin
  for policy_name in
    select polname from pg_policy
    where polrelid = 'public.app_settings'::regclass
  loop
    execute format('drop policy %I on public.app_settings', policy_name);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants for the self-hosted PostgREST stack.
--
-- On a bundled install the deploy/db/roles.sql init script creates the anon
-- and authenticated roles and sets default privileges, so tables created AFTER
-- that script already have the right grants. But the default-privileges mechanism
-- does not retroactively cover tables that already exist (e.g. after an upgrade
-- that adds a new table before the roles init ran). These explicit grants are
-- idempotent and cover both cases.
--
-- On hosted Supabase the roles already exist and the grants are redundant but
-- harmless. On plain Postgres (no anon role) the DO block is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant select, insert, update, delete on all tables in schema public to anon, authenticated;
    grant usage, select on all sequences in schema public to anon, authenticated;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- …and review_lines loses its update and delete again, for the same reason and
-- in the same position (added 2026-09-25, docs/plan/15-sessions-and-variants.md
-- batch BL). The grant above is `on all tables`, so it has just handed the two
-- browser roles an UPDATE that the row level security policies above refuse.
-- Row level security alone is enough — a table with RLS enabled and no policy for
-- a command denies it — but the block above is evaluated when it runs and would
-- otherwise be the only thing between a re-applied schema and an anon caller that
-- can re-open a variant somebody adopted last month. Two mechanisms agreeing is
-- the pattern this file already uses for app_settings, and a table grant is
-- checked before RLS, so the revoke has to come after the grant.
--
-- SELECT and INSERT stay: the map, the tracker's line filter and the room's chip
-- all read lines, and lib/reviews/linesRepo.ensureMainLine inserts the one
-- `kind = 'main'` row its policy allows.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke update, delete on public.review_lines from anon, authenticated;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- …and review_curations loses its DELETE, for the same reason and in the same
-- position (added 2026-09-25, docs/plan/15-sessions-and-variants.md batch BN).
-- The grant above has just handed the two browser roles a DELETE that the absence
-- of a delete policy already refuses; a table grant is checked BEFORE row level
-- security, so without this revoke the missing policy would be the only thing
-- between the published anon key and every design review on the install.
--
-- Deleting a review is `delete_review(p_review)` — the review's meetings, cards,
-- lines, roster and revisions in one transaction — called by
-- api/reviews/delete.ts with the service role, which is also where the caller's
-- role is checked. Two mechanisms agreeing is the pattern this file uses for
-- app_settings and for review_lines.
--
-- SELECT, INSERT and UPDATE stay: a 'none' install writes its curation rows with
-- the anon key, and every room reads its own.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke delete on public.review_curations from anon, authenticated;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- …except app_settings, which the block above just granted along with every
-- other table. This revoke is LAST ON PURPOSE: `grant … on all tables in
-- schema public` is evaluated when it runs, so it picks up app_settings like
-- any other table, and a table-level grant is checked BEFORE Row Level
-- Security. Without this, the two browser roles would have select on the
-- credentials table and RLS-with-no-policies would be the only thing stopping
-- them — one mechanism instead of two, and the weaker one to bet a set of API
-- keys on. The supabase/postgres image also installs a DEFAULT PRIVILEGES rule
-- that grants new tables to anon and authenticated as they are created, which
-- is why revoking here is not enough on its own for a table added later: any
-- new table holding a secret needs its own revoke in this same position.
--
-- Idempotent like everything else in this file, so install.sh re-applying it on
-- every run keeps the two mechanisms agreeing after an upgrade.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.app_settings from anon, authenticated;
  end if;
end $$;
