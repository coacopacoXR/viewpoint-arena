import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { LabelField } from '../../../lib/supabase';

const reorderFieldsMock = vi.fn().mockResolvedValue(undefined);
const addFieldMock = vi.fn();
const renameFieldMock = vi.fn();
const updateFieldValuesMock = vi.fn();
const removeFieldMock = vi.fn();

vi.mock('../../../lib/labelFieldsStore', () => ({
  useLabelFieldsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      addField: addFieldMock,
      renameField: renameFieldMock,
      updateFieldValues: updateFieldValuesMock,
      reorderFields: reorderFieldsMock,
      removeField: removeFieldMock,
    }),
}));

import LabelFieldsSettings from '../LabelFieldsSettings';

const field = (id: string, name: string, position: number): LabelField => ({
  id,
  name,
  position,
  values: [],
  created_at: '2026-09-23T00:00:00Z',
});

const fields = [field('f1', 'Alpha', 0), field('f2', 'Beta', 1), field('f3', 'Gamma', 2)];

/**
 * Drags a row the way a person does: press the grip, which is what makes the
 * row draggable at all, then drag it onto another row. The grip exists so
 * that dragging to select text inside the field-name input does not pick the
 * whole row up.
 */
function dragRow(fromIdx: number, toIdx: number) {
  const rows = document.querySelectorAll('[data-testid="label-field-row"]');
  const grips = document.querySelectorAll('[aria-label="Drag to reorder"]');
  fireEvent.mouseDown(grips[fromIdx]);
  fireEvent.dragStart(rows[fromIdx]);
  fireEvent.dragOver(rows[toIdx]);
  fireEvent.drop(rows[toIdx]);
  fireEvent.dragEnd(rows[fromIdx]);
}

describe('LabelFieldsSettings — drag to reorder', () => {
  it('a row is not draggable until its grip is held', () => {
    // Otherwise dragging to select text in the field-name input drags the row.
    render(<LabelFieldsSettings fields={fields} onClose={vi.fn()} />);
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);

    fireEvent.mouseDown(document.querySelectorAll('[aria-label="Drag to reorder"]')[0]);
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const onClose = vi.fn();

  it('dropping row 3 onto row 1 calls reorderFields with the new order', () => {
    const { container } = render(
      <LabelFieldsSettings fields={fields} onClose={onClose} />,
    );
    void container;

    dragRow(2, 0);

    expect(reorderFieldsMock).toHaveBeenCalledTimes(1);
    expect(reorderFieldsMock).toHaveBeenCalledWith(['f3', 'f1', 'f2']);
  });

  it('a drop on the row it started from does not call reorderFields', () => {
    render(<LabelFieldsSettings fields={fields} onClose={onClose} />);

    dragRow(1, 1);

    expect(reorderFieldsMock).not.toHaveBeenCalled();
  });
});
