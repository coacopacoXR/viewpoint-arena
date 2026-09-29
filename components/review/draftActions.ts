// The contract between a curation tab and wherever it is being rendered.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH moved the curation tabs out of
// pages/ReviewSetupPage and into the room's own side panel, with Edit on. The
// tabs are ONE copy — the brief was explicit that the room and the old page must
// not each grow their own — so they cannot reach into a store: the setup page
// kept its draft in lib/reviewSetupStore and the room keeps the live review in
// lib/activeReviewStore, and a component that imported either would only ever
// work in one of the two places.
//
// So a tab takes its data as props and its writes as `actions`. Each caller
// builds the actions object from its own store, which is also where the room's
// extra step lives: every write there has to be broadcast, because five other
// people are looking at the same review. The tab does not know or care.

import type {
  AgendaItem,
  NewAgendaItem,
  ReviewPin,
  ReviewViewpoint,
} from '../../lib/reviewSetupStore';
import type { Requirement } from '../../types';

/**
 * Every write a curation tab can make.
 *
 * Deliberately the same signatures lib/reviewSetupStore and lib/activeReviewStore
 * already offer — a partial object merged over the stored record, so renaming a
 * pin does not send its severity. Nothing here is a new idea about how a review
 * is edited, which is the point: a caller adapts its own store to this shape and
 * the tabs work in both places unchanged.
 */
export interface ReviewDraftActions {
  updateViewpoint(id: string, updates: Partial<ReviewViewpoint>): void;
  removeViewpoint(id: string): void;

  updatePin(id: string, updates: Partial<ReviewPin>): void;
  /**
   * Add a pin. Batch BI: the room grew a way to place one on the model, so the tab
   * that lists pins had to be able to write one. Same shape lib/reviewSetupStore
   * has always offered, minus the returned id — a tab does not need it, and the
   * caller that does (the room's Edit panel, which selects the pin it just added)
   * reads it back from its own store.
   */
  addPin(pin: Omit<ReviewPin, 'id' | 'createdAt'>): void;
  removePin(id: string): void;

  addAgendaItem(item: NewAgendaItem): void;
  updateAgendaItem(id: string, updates: Partial<AgendaItem>): void;
  removeAgendaItem(id: string): void;
  reorderAgenda(fromIndex: number, toIndex: number): void;
  attachViewpointToAgendaItem(itemId: string, viewpointId: string): void;
  detachViewpointFromAgendaItem(itemId: string, viewpointId: string): void;
  attachPinToAgendaItem(itemId: string, pinId: string): void;
  detachPinFromAgendaItem(itemId: string, pinId: string): void;

  addRequirement(requirement: Omit<Requirement, 'id'>): void;
  updateRequirement(id: string, updates: Partial<Requirement>): void;
  removeRequirement(id: string): void;
  reorderRequirements(fromIndex: number, toIndex: number): void;

  setLabel(fieldId: string, value: string): void;
  clearLabel(fieldId: string): void;
}

/**
 * The severity a pin can carry, and how each one reads on screen.
 *
 * Exported from here rather than from the Pins tab because two tabs render a
 * pin's severity chip — Pins itself, and an agenda slide's attachment row — and
 * the two must not drift apart in colour. That was already true when both lived
 * in one 1,900-line file; now that they are separate files it has to be said.
 */
export const PIN_SEVERITIES = ['info', 'concern', 'blocker'] as const;
