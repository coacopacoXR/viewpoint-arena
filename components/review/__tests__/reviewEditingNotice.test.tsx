// What the room says about Edit to the people who do not have it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. Three messages, one stack, and
// only one of them is true at a time for any given person — which is what these
// tests pin, because the failure mode of getting it wrong is a room that argues
// with itself.
//
//   • the banner names whoever has Edit on, and never greets the person who has
//     it: that person gets the amber strip, so a banner about themselves would be
//     a second, contradictory answer to "am I editing?".
//   • the prompt is the room's refusal of a press of Edit, and the ONLY place a
//     take-over is offered — taking Edit away from somebody is a decision, so it
//     is never one click from the banner. A refusal of 'role' offers nothing,
//     because there is nobody to take it over from.
//   • while a refusal is up the banner is suppressed: both would be about the
//     same fact, and one of them would be offering a button the other forbids.
//   • each message dismisses itself and no other, and the notice outlives the
//     lock it was about — the person who was displaced sees it after Edit has
//     already moved to somebody else.
//
// All three read state the room server wrote into the store. None of them
// guesses, which is what keeps "only one person edits at a time" from being six
// clients' opinions about it.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useStore } from '../../../store';
import ReviewEditingNotice from '../ReviewEditingNotice';

const TAKE_OVER = 'Take over';

function renderNotice(localUserId: string, onTakeOver = vi.fn()) {
  const view = render(
    <ReviewEditingNotice localUserId={localUserId} onTakeOver={onTakeOver} />,
  );
  return { ...view, onTakeOver };
}

beforeEach(() => {
  useStore.setState({ reviewEditing: null, reviewEditRefusal: null, reviewEditNotice: null });
});

afterEach(() => {
  cleanup();
  useStore.setState({ reviewEditing: null, reviewEditRefusal: null, reviewEditNotice: null });
});

describe('the room\'s editing messages', () => {
  it('renders nothing at all when nobody is editing and nothing was refused', () => {
    const { container } = renderNotice('u1');

    expect(container.firstChild).toBeNull();
  });

  it('names the person who has Edit on, to everybody else', () => {
    useStore.setState({ reviewEditing: { userId: 'u2', name: 'Robin' } });

    renderNotice('u1');

    expect(screen.getByText('Robin is editing the review')).toBeInTheDocument();
  });

  it('says nothing to the person who has Edit on', () => {
    // The same state, read by the editor: they have the amber strip, and a banner
    // about themselves would be a second answer to a question they just answered.
    useStore.setState({ reviewEditing: { userId: 'u2', name: 'Robin' } });

    const { container } = renderNotice('u2');

    expect(screen.queryByText('Robin is editing the review')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('says "Somebody" when the room did not carry a name', () => {
    useStore.setState({ reviewEditing: { userId: 'u2', name: '' } });

    renderNotice('u1');

    expect(screen.getByText('Somebody is editing the review')).toBeInTheDocument();
  });

  it('offers a take over when a press of Edit was refused because somebody has it', () => {
    useStore.setState({ reviewEditRefusal: { reason: 'busy', editorName: 'Robin' } });
    const { onTakeOver } = renderNotice('u1');

    expect(screen.getByText('Robin is editing')).toBeInTheDocument();

    // The force=true second EDITING_START: one press, asked for from here only.
    fireEvent.click(screen.getByRole('button', { name: TAKE_OVER }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it('leaves the banner down while the prompt about the same fact is up', () => {
    useStore.setState({
      reviewEditing: { userId: 'u2', name: 'Robin' },
      reviewEditRefusal: { reason: 'busy', editorName: 'Robin' },
    });

    renderNotice('u1');

    expect(screen.getByText('Robin is editing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TAKE_OVER })).toBeInTheDocument();
    expect(screen.queryByText('Robin is editing the review')).toBeNull();
  });

  it('explains a refusal of role without offering anything to do about it', () => {
    useStore.setState({ reviewEditRefusal: { reason: 'role', editorName: null } });

    renderNotice('u1');

    expect(
      screen.getByText('Editing this review is for its owner and its editors'),
    ).toBeInTheDocument();
    // Nothing to take over from: the tools were never this person's.
    expect(screen.queryByRole('button', { name: TAKE_OVER })).toBeNull();
  });

  it('clears the prompt, and only the prompt, when it is dismissed', () => {
    useStore.setState({ reviewEditRefusal: { reason: 'busy', editorName: 'Robin' } });

    renderNotice('u1');
    fireEvent.click(screen.getByTitle('Dismiss'));

    expect(useStore.getState().reviewEditRefusal).toBeNull();
    expect(screen.queryByText('Robin is editing')).toBeNull();
  });

  it('shows a take-over notice once nobody is editing any more', () => {
    // The lock has already moved on; the person who was displaced still needs to
    // be told why their tools went away.
    useStore.setState({ reviewEditNotice: 'Maria took over editing' });

    renderNotice('u1');

    expect(screen.getByText('Maria took over editing')).toBeInTheDocument();
    expect(screen.getByTitle('Dismiss')).toBeInTheDocument();
  });

  it('clears the notice, and only the notice, when it is dismissed', () => {
    useStore.setState({ reviewEditNotice: 'Maria took over editing' });

    renderNotice('u1');
    fireEvent.click(screen.getByTitle('Dismiss'));

    expect(useStore.getState().reviewEditNotice).toBeNull();
    expect(screen.queryByText('Maria took over editing')).toBeNull();
  });
});
