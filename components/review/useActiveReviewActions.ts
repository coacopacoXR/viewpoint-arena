// The room's side of the curation tabs' contract.
//
// components/review/draftActions.ts says what a tab may do to a review; this is
// what doing it MEANS inside a room. Two steps rather than the one the curate page
// took, and the second is the whole reason the tabs are store-agnostic:
//
//   1. write to lib/activeReviewStore, which is the copy of the review this room
//      is presenting — the same copy a REVIEW_CONFIG from the room server updates,
//      so an editor and a listener are looking at one thing;
//   2. broadcast the draft that came back, so everybody else's copy becomes it.
//
// Step 2 is not optional and not debounced. The room server relays a REVIEW_CONFIG
// to every other connection and remembers it for whoever joins next; without the
// broadcast an edit would be visible on one screen and nowhere else, which is
// exactly the failure the old curate page could not have — it had nobody to tell.
//
// Persistence is not here either, but it happens because of what is here: a store
// action marks the review as edited by THIS browser (lib/reviewLocalEdit), and
// RoomPage's subscriber saves a second after the last mark — and only on a mark.
// Batch BH widened who that subscriber listens to (the meeting host, or whoever
// has Edit on) rather than adding a second writer that could race it; batch BH3
// made the mark the thing that decides, because a subscriber that saved on any
// change to the review also saved changes that had arrived from somebody else.

import { useMemo } from 'react';
import { usePresence } from '../../lib/PresenceContext';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import type { ReviewAssetReference, ReviewDraft, ReviewPin, ReviewViewpoint } from '../../lib/reviewSetupStore';
import type { Requirement } from '../../types';
import type { NewAgendaItem } from '../../lib/reviewSetupStore';
import type { ReviewDraftActions } from './draftActions';

/**
 * The room's writes that no curation tab makes.
 *
 * Deliberately NOT part of draftActions.ts: that interface is the contract a tab is
 * rendered against and every caller has to satisfy it, whereas these have callers
 * outside the tabs — the PLM launch, recording the document the review was opened
 * from, and the Edit panel's own header, naming the review (batch BQ). Widening the
 * tab contract for them would mean inventing a no-op for every test that builds one,
 * to describe a write no tab can make.
 *
 * Both go through the same `publish` as the rest, so the reference and the name
 * reach everybody else in the room and not only this screen.
 */
export interface ReviewLaunchActions {
  addReference(ref: Omit<ReviewAssetReference, 'id'>): void;
  /** Name the review. An empty name keeps the one it has. */
  setTitle(title: string): void;
}

export function useActiveReviewActions(): ReviewDraftActions & ReviewLaunchActions {
  const { broadcastReviewConfig } = usePresence();

  return useMemo(() => {
    /**
     * Apply one write and tell the room what the review became.
     *
     * The store's mutators answer with the new draft, or null when no review is
     * open — in which case there is nothing to broadcast and nothing anybody
     * could have seen change.
     */
    const publish = (next: ReviewDraft | null): void => {
      if (!next) return;
      // A socket that is not open yet is not a reason to lose the edit: the room
      // server replays its remembered REVIEW_CONFIG to a connection on admission,
      // and this browser's own copy is already correct. The next write carries
      // both. (RoomPage does the same thing for the review it seeds a room with,
      // and retries there because a seed is the one write with no later one.)
      broadcastReviewConfig(next);
    };

    const store = useActiveReviewStore.getState;

    return {
      setTitle: (title: string) => publish(store().setTitle(title)),
      updateViewpoint: (id: string, updates: Partial<ReviewViewpoint>) => publish(store().updateViewpoint(id, updates)),
      removeViewpoint: (id: string) => publish(store().removeViewpoint(id)),
      updatePin: (id: string, updates: Partial<ReviewPin>) => publish(store().updatePin(id, updates)),
      addPin: (pin: Omit<ReviewPin, 'id' | 'createdAt'>) => publish(store().addPin(pin)),
      removePin: (id: string) => publish(store().removePin(id)),
      addAgendaItem: (item: NewAgendaItem) => publish(store().addAgendaItem(item)),
      updateAgendaItem: (id: string, updates: Partial<NewAgendaItem>) => publish(store().updateAgendaItem(id, updates)),
      removeAgendaItem: (id: string) => publish(store().removeAgendaItem(id)),
      reorderAgenda: (fromIndex: number, toIndex: number) => publish(store().reorderAgenda(fromIndex, toIndex)),
      attachViewpointToAgendaItem: (itemId: string, viewpointId: string) => publish(store().attachViewpointToAgendaItem(itemId, viewpointId)),
      detachViewpointFromAgendaItem: (itemId: string, viewpointId: string) => publish(store().detachViewpointFromAgendaItem(itemId, viewpointId)),
      attachPinToAgendaItem: (itemId: string, pinId: string) => publish(store().attachPinToAgendaItem(itemId, pinId)),
      detachPinFromAgendaItem: (itemId: string, pinId: string) => publish(store().detachPinFromAgendaItem(itemId, pinId)),
      addRequirement: (requirement: Omit<Requirement, 'id'>) => publish(store().addRequirement(requirement)),
      updateRequirement: (id: string, updates: Partial<Requirement>) => publish(store().updateRequirement(id, updates)),
      removeRequirement: (id: string) => publish(store().removeRequirement(id)),
      reorderRequirements: (fromIndex: number, toIndex: number) => publish(store().reorderRequirements(fromIndex, toIndex)),
      setLabel: (fieldId: string, value: string) => publish(store().setLabel(fieldId, value)),
      clearLabel: (fieldId: string) => publish(store().clearLabel(fieldId)),
      addReference: (ref: Omit<ReviewAssetReference, 'id'>) => publish(store().addReference(ref)),
    };
  }, [broadcastReviewConfig]);
}
