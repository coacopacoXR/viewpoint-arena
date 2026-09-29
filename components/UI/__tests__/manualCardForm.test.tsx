// The hand-made card (docs/plan/14-rooms-models-admin-ai.md batch BG).
//
// Two halves, because the form is only interesting in what it produces: the pure
// helpers are the contract the tracker and the broadcast both rely on, and the
// rendered form is the part a person actually uses.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ManualCardForm, {
  buildManualCard,
  pointedPartFor,
  newManualCardId,
  type ManualCardInput,
} from '../ManualCardForm';
import type { FlatComponent } from '../../../lib/componentIndex';

const PART: FlatComponent = { id: 'node-14', name: 'Left Ear Cup', path: 'Headphones / Left Ear Cup' };
const COMPONENTS: FlatComponent[] = [
  { id: 'root', name: 'Headphones', path: 'Headphones' },
  PART,
  { id: 'node-22', name: 'Headband', path: 'Headphones / Headband' },
];

function input(overrides: Partial<ManualCardInput> = {}): ManualCardInput {
  return {
    type: 'RISK',
    title: 'Pad cracks at the hinge',
    description: 'Maria: it will crack inside six months.',
    priority: 'High',
    assignee: '',
    dueDate: '',
    ...overrides,
  };
}

function openForm(part: FlatComponent | null = null) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <ManualCardForm
      part={part ? { id: part.id, name: part.name } : null}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return { onSave, onCancel, form: screen.getByRole('form', { name: 'New card' }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('buildManualCard', () => {
  it('marks the card hand-made and names who made it', () => {
    const card = buildManualCard(input(), {
      part: null,
      createdByName: 'Maria Okafor',
      now: 1_700_000_000_000,
      id: 'insight-manual-1',
    });

    expect(card.source).toBe('manual');
    expect(card.createdByName).toBe('Maria Okafor');
    expect(card.id).toBe('insight-manual-1');
    expect(card.timestamp).toBe(1_700_000_000_000);
    // No agent wrote it. Every consumer looks an agent up by this id, so an
    // empty string answers "none" instead of matching somebody's agent.
    expect(card.agentId).toBe('');
    expect(card.details.status).toBe('Open');
    expect(card.title).toBe('Pad cracks at the hinge');
  });

  it('attaches the part the way a grounded AI card does', () => {
    const withPart = buildManualCard(input(), {
      part: { id: PART.id, name: PART.name },
      createdByName: 'Maria Okafor',
      now: 0,
      id: 'a',
    });
    const without = buildManualCard(input(), { part: null, createdByName: 'M', now: 0, id: 'b' });

    // componentReference holds the node ID, not the name: that is what
    // lib/trackerBridge.cardPart reads to work out part_node_id, and what the
    // extraction prompt tells a model to echo back from the component list.
    expect(withPart.details.componentReference).toBe('node-14');
    expect(without.details.componentReference).toBeUndefined();
  });

  it('carries assignee and due date, and omits the ones nobody filled in', () => {
    const action = buildManualCard(
      input({ type: 'ACTION', assignee: '  Pete  ', dueDate: '2026-10-02' }),
      { part: null, createdByName: 'M', now: 0, id: 'c' },
    );
    const risk = buildManualCard(input(), { part: null, createdByName: 'M', now: 0, id: 'd' });

    expect(action.details.assignee).toBe('Pete');
    expect(action.details.dueDate).toBe('2026-10-02');
    // An unset optional must be ABSENT, not an empty string: the tracker writes
    // `?? null` and the summary prompt prints only the extras that are there.
    expect('assignee' in risk.details).toBe(false);
    expect('dueDate' in risk.details).toBe(false);
  });
});

describe('pointedPartFor', () => {
  it('prefers a fresh laser target, which is the only source that carries a name', () => {
    expect(
      pointedPartFor({
        laser: { id: 'node-22', name: 'Headband' },
        selectedNodeId: 'node-14',
        components: COMPONENTS,
      }),
    ).toEqual({ id: 'node-22', name: 'Headband' });
  });

  it('falls back to the selected node, naming it from the tree', () => {
    expect(
      pointedPartFor({ laser: null, selectedNodeId: 'node-14', components: COMPONENTS }),
    ).toEqual({ id: 'node-14', name: 'Left Ear Cup' });
  });

  it('ignores a laser entry with no part name', () => {
    expect(
      pointedPartFor({
        laser: { id: 'node-22', name: null },
        selectedNodeId: 'node-14',
        components: COMPONENTS,
      }),
    ).toEqual({ id: 'node-14', name: 'Left Ear Cup' });
  });

  it('answers null when nothing is selected and the laser is off', () => {
    expect(pointedPartFor({ laser: null, selectedNodeId: null, components: COMPONENTS })).toBeNull();
  });

  it('answers null for a selection the tree no longer knows', () => {
    // A model replaced while the form was open: a stale id with no name would be
    // a checkbox offering a bare node id.
    expect(
      pointedPartFor({ laser: null, selectedNodeId: 'gone-1', components: COMPONENTS }),
    ).toBeNull();
  });
});

describe('newManualCardId', () => {
  it('is in the parser’s insight- family and never repeats', () => {
    const ids = new Set(Array.from({ length: 25 }, () => newManualCardId()));
    expect(ids.size).toBe(25);
    for (const id of ids) expect(id.startsWith('insight-manual-')).toBe(true);
  });
});

describe('the form itself', () => {
  it('will not save without a title', () => {
    const { onSave, form } = openForm();
    expect(screen.getByTitle('A title is required')).toBeTruthy();
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledTimes(0);
  });

  it('saves what was typed', () => {
    const { onSave, form } = openForm();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pad cracks' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Within six months' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'Critical' } });
    fireEvent.submit(form);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      {
        type: 'RISK',
        title: 'Pad cracks',
        description: 'Within six months',
        priority: 'Critical',
        assignee: '',
        dueDate: '',
      },
      null,
    );
  });

  it('uses the same three words and colours the AI cards use', () => {
    openForm();
    for (const label of ['Risk', 'Action', 'Rationale']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Risk' }).className).toContain('text-red-600');
    expect(screen.getByRole('button', { name: 'Action' }).className).toContain('text-blue-600');
    expect(screen.getByRole('button', { name: 'Rationale' }).className).toContain('text-amber-600');
  });

  it('asks for an assignee and a due date only for an action', () => {
    const { onSave, form } = openForm();
    expect(screen.queryByLabelText('Assignee')).toBeNull();
    expect(screen.queryByLabelText('Due date')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Action' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Measure the stack-up' } });
    fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'Pete' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-02' } });
    fireEvent.submit(form);

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ACTION', assignee: 'Pete', dueDate: '2026-10-02' }),
      null,
    );
  });

  it('offers the part only when the room has one, ticked by default', () => {
    const { onSave, form } = openForm(PART);
    const box = screen.getByRole('checkbox');
    expect(screen.getByText('Left Ear Cup')).toBeTruthy();
    expect((box as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pad cracks' } });
    fireEvent.submit(form);
    expect(onSave).toHaveBeenCalledWith(expect.anything(), { id: 'node-14', name: 'Left Ear Cup' });
  });

  it('drops the part when the box is unticked', () => {
    const { onSave, form } = openForm(PART);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'About the meeting' } });
    fireEvent.submit(form);

    expect(onSave).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('cancels without saving', () => {
    const { onSave, onCancel } = openForm();
    fireEvent.click(screen.getByTitle('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(0);
  });
});
