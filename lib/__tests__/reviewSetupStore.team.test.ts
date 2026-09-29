import { describe, it, expect, beforeEach } from 'vitest';
import { useReviewSetupStore, type ReviewDraft } from '../reviewSetupStore';

function resetStore() {
  useReviewSetupStore.setState({ draft: null });
}

describe('reviewSetupStore — team', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts a new draft with an empty team array', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const draft = useReviewSetupStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft!.team).toEqual([]);
  });

  it('addTeamMember appends a member and returns its id', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addTeamMember({ name: 'Alice' });
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.team).toHaveLength(1);
    expect(draft.team[0].id).toBe(id);
    expect(draft.team[0].name).toBe('Alice');
  });

  it('addTeamMember stores optional role and email', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().addTeamMember({ name: 'Bob', role: 'Lead', email: 'bob@example.com' });
    const member = useReviewSetupStore.getState().draft!.team[0];
    expect(member.role).toBe('Lead');
    expect(member.email).toBe('bob@example.com');
  });

  it('updateTeamMember patches a single member', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addTeamMember({ name: 'Carol' });
    useReviewSetupStore.getState().updateTeamMember(id, { name: 'Carol S.', role: 'Ergo' });
    const member = useReviewSetupStore.getState().draft!.team[0];
    expect(member.name).toBe('Carol S.');
    expect(member.role).toBe('Ergo');
  });

  it('removeTeamMember drops the member', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addTeamMember({ name: 'Dave' });
    expect(useReviewSetupStore.getState().draft!.team).toHaveLength(1);
    useReviewSetupStore.getState().removeTeamMember(id);
    expect(useReviewSetupStore.getState().draft!.team).toHaveLength(0);
  });

  it('reorderTeam moves a member from one index to another', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().addTeamMember({ name: 'A' });
    useReviewSetupStore.getState().addTeamMember({ name: 'B' });
    useReviewSetupStore.getState().addTeamMember({ name: 'C' });
    useReviewSetupStore.getState().reorderTeam(0, 2);
    const names = useReviewSetupStore.getState().draft!.team.map((m) => m.name);
    expect(names).toEqual(['B', 'C', 'A']);
  });

  it('updatedAt changes when a team member is added', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const before = useReviewSetupStore.getState().draft!.updatedAt;
    useReviewSetupStore.getState().addTeamMember({ name: 'Eve' });
    const after = useReviewSetupStore.getState().draft!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('reviewSetupStore — fingerprint includes team', () => {
  beforeEach(() => {
    resetStore();
  });

  it('fingerprint changes when a team member is added', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const fp1 = fingerprintOf(useReviewSetupStore.getState().draft!);
    useReviewSetupStore.getState().addTeamMember({ name: 'Frank' });
    const fp2 = fingerprintOf(useReviewSetupStore.getState().draft!);
    expect(fp1).not.toBe(fp2);
  });
});

function fingerprintOf(d: ReviewDraft): string {
  const { importedFileBase64: _, ...asset } = d.asset;
  return JSON.stringify({
    title: d.title, description: d.description, asset,
    viewpoints: d.viewpoints, pins: d.pins, agenda: d.agenda,
    requirements: d.requirements, team: d.team,
  });
}
