// LabelsTab's free-text suggestions.
//
// Moved here from pages/__tests__ when batch BH moved the tab itself out of the
// curate page and into components/review/. Same two questions, same answers — the
// only change is that the tab no longer reaches into lib/reviewSetupStore for its
// data, so the test hands it `labels` and `actions` as props instead of mocking a
// store it no longer reads.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { mockListUsedLabelValues } = vi.hoisted(() => ({
  mockListUsedLabelValues: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../lib/curationsRepo', () => ({
  listUsedLabelValues: mockListUsedLabelValues,
}));

const loadFieldsMock = vi.fn();

vi.mock('../../../lib/labelFieldsStore', () => ({
  useLabelFieldsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      fields: [
        { id: 'free', name: 'Free', position: 0, values: [] },
        { id: 'fixed', name: 'Fixed', position: 1, values: ['A', 'B'] },
      ],
      loaded: true,
      load: loadFieldsMock,
    }),
}));

import { LabelsTab } from '../LabelsTab';
import type { ReviewDraftActions } from '../draftActions';

/** Every write a no-op: this test is about the suggestions, not about saving. */
const noopActions: ReviewDraftActions = {
  updateViewpoint: () => {},
  removeViewpoint: () => {},
  updatePin: () => {},
  addPin: () => {},
  removePin: () => {},
  addAgendaItem: () => {},
  updateAgendaItem: () => {},
  removeAgendaItem: () => {},
  reorderAgenda: () => {},
  attachViewpointToAgendaItem: () => {},
  detachViewpointFromAgendaItem: () => {},
  attachPinToAgendaItem: () => {},
  detachPinFromAgendaItem: () => {},
  addRequirement: () => {},
  updateRequirement: () => {},
  removeRequirement: () => {},
  reorderRequirements: () => {},
  setLabel: () => {},
  clearLabel: () => {},
};

const renderTab = () => render(<LabelsTab labels={{}} actions={noopActions} />);

describe('LabelsTab — datalist suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUsedLabelValues.mockResolvedValue({
      free: ['Alpha', 'Beta'],
      fixed: ['Should', 'Not', 'Appear'],
    });
  });

  it('renders a <datalist> with used values for a free-text field', async () => {
    const { container } = renderTab();

    await waitFor(() => {
      const datalist = container.querySelector('datalist#label-suggestions-free');
      expect(datalist).not.toBeNull();
    });

    const datalist = container.querySelector('datalist#label-suggestions-free');
    const options = datalist!.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('value')).toBe('Alpha');
    expect(options[1].getAttribute('value')).toBe('Beta');
  });

  it('does not render a <datalist> for a field with a fixed value list', async () => {
    const { container } = renderTab();

    await waitFor(() => {
      expect(container.querySelector('datalist#label-suggestions-free')).not.toBeNull();
    });

    expect(container.querySelector('datalist#label-suggestions-fixed')).toBeNull();
  });
});
