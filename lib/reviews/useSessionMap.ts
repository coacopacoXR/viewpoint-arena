// What the session map draws, fetched.
//
// docs/plan/15-sessions-and-variants.md batch BK. components/review/SessionMap.tsx
// reads the database nothing at all — it is given lines, sessions, revisions and
// cards and draws them — so that the same component can sit over the room's canvas
// and inside the tracker's design-review view, and so a test can hand it fixture
// data and assert on the drawing. This is the half that fetches.
//
// Four reads, made together, and all four already answer "nothing" rather than
// throwing: a review on an install whose database has not been re-applied since
// this batch gets an empty map and an empty message, not an error boundary. The map
// is opened on purpose by somebody pressing a button, so it reads when it is asked
// to and not on every room render.

import { useCallback, useEffect, useState } from 'react';
import {
  listLines,
  listReviewCardRefs,
  listReviewSessions,
  resetLineCache,
  sessionTranscript,
  type LineSession,
  type SessionCardRef,
} from './linesRepo';
import { listModelRevisions, type ModelRevision } from './revisionsRepo';
import type { TranscriptRow } from '../capture/transcriptText';
import type { ReviewLine } from './lines';

export interface SessionMapData {
  lines: ReviewLine[];
  sessions: LineSession[];
  revisions: ModelRevision[];
  cards: SessionCardRef[];
  loading: boolean;
  /** Read again. Drops the line cache first, so a variant created since appears. */
  refresh: () => void;
  /**
   * Read ONE meeting's transcript, for the map's panel to offer as a .txt.
   *
   * Handed to the map rather than called by it, because
   * components/review/SessionMap.tsx reads the database nothing at all — it is given
   * what it draws. Not fetched up front with the four reads below either: batch BU
   * made a transcript up to two megabytes of one meeting, and the map draws a dot for
   * each of possibly twenty of them. It is asked for when somebody clicks a stop,
   * which is the only moment anybody wants it.
   */
  readTranscript: (sessionId: string) => Promise<TranscriptRow[] | null>;
}

const EMPTY: Omit<SessionMapData, 'loading' | 'refresh' | 'readTranscript'> = {
  lines: [],
  sessions: [],
  revisions: [],
  cards: [],
};

export function useSessionMap(reviewId: string | null | undefined): SessionMapData {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  // Bumped by refresh() so the effect below re-runs for the same review id.
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    // The module cache exists so one page load does not ask for the same rows
    // three times; a refresh is the one moment the caller is saying "ask again".
    resetLineCache();
    setNonce((n) => n + 1);
  }, []);

  // A stable function rather than one rebuilt per render: the map puts it in an
  // effect's dependency list, and a fresh identity per render would make that effect
  // read the selected meeting's transcript on every render of the page holding it.
  const readTranscript = useCallback(
    (sessionId: string) => sessionTranscript(sessionId),
    [],
  );

  useEffect(() => {
    if (!reviewId) {
      setData(EMPTY);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [lines, sessions, revisions, cards] = await Promise.all([
        listLines(reviewId),
        listReviewSessions(reviewId),
        listModelRevisions(reviewId),
        listReviewCardRefs(reviewId),
      ]);
      if (cancelled) return;
      setData({ lines, sessions, revisions, cards });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [reviewId, nonce]);

  return { ...data, loading, refresh, readTranscript };
}
