import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useStore } from '../../../store';
import SceneTree from '../SceneTree';

// Mock scrollIntoView (not implemented in jsdom)
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock the presence context
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    broadcastSceneUpdate: vi.fn(() => true),
    broadcastSetModelEditors: vi.fn(() => true),
    localUserId: 'test-user',
    remoteParticipantList: [],
  }),
}));

describe('SceneTree', () => {
  beforeEach(() => {
    // Reset store state
    useStore.setState({
      activeModelType: 'headphones',
      objectStates: {
        headphones_assembly: { id: 'headphones_assembly', visible: true, selected: false, expanded: true },
        headphones_0: { id: 'headphones_0', visible: true, selected: false, expanded: false },
        headphones_1: { id: 'headphones_1', visible: true, selected: false, expanded: false },
        headphones_2: { id: 'headphones_2', visible: true, selected: false, expanded: false },
      },
      headphonesSceneTree: {
        id: 'headphones_assembly',
        name: 'Headphones',
        type: 'GROUP',
        children: [
          {
            id: 'headphones_0',
            name: 'Group 1',
            type: 'GROUP',
            children: [
              { id: 'headphones_1', name: 'Mesh 1', type: 'MESH' },
              { id: 'headphones_2', name: 'Mesh 2', type: 'MESH' },
            ],
          },
        ],
      },
      bicycleSceneTree: null,
      importedSceneTree: null,
    });
  });

  it('expands ancestors when a nested node is selected', () => {
    // Select a deeply nested node
    useStore.getState().selectNode('headphones_2');

    render(<SceneTree />);

    // Check that the ancestor was expanded
    const state = useStore.getState();
    expect(state.objectStates['headphones_0'].expanded).toBe(true);
  });

  it('does not collapse already expanded ancestors', () => {
    // Start with ancestor expanded
    useStore.setState((state) => ({
      objectStates: {
        ...state.objectStates,
        headphones_0: { ...state.objectStates['headphones_0'], expanded: true },
      },
    }));

    // Select a nested node
    useStore.getState().selectNode('headphones_2');

    render(<SceneTree />);

    // Ancestor should still be expanded
    const state = useStore.getState();
    expect(state.objectStates['headphones_0'].expanded).toBe(true);
  });
});
