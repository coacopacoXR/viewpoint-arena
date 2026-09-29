// What the lobby's "Room code or link" box accepts.
//
// docs/plan/15-sessions-and-variants.md batch BO. The box used to take a bare room id and
// nothing else, which meant the one thing everybody actually has — the link somebody
// pasted into Teams — had to be unpicked by hand first. What is pinned here is that all
// three spellings arrive at the same room, and that the LINE a variant's link names
// survives, because dropping it would put somebody invited to Variant A into the main
// line's meeting: a different room, looking at a different model.
//
// And that a box with nothing recognisable in it is refused rather than entered as a room
// id that will never resolve — opening a room called "https:" is worse than saying no.

import { describe, it, expect } from 'vitest';
import { parseJoinTarget } from '../joinTarget';

const ID = '2f1c9a4e-77b6-4d0e-9a11-6c1e0b7d5f33';
const LINE = '9d0b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4';

describe('parseJoinTarget', () => {
  it('takes a bare room id', () => {
    expect(parseJoinTarget(ID)).toEqual({ roomId: ID, lineId: null });
  });

  it('takes a short code, which is what a person reads out loud', () => {
    expect(parseJoinTarget('bracket-7')).toEqual({ roomId: 'bracket-7', lineId: null });
  });

  it('trims what was pasted, including the newline a chat client adds', () => {
    expect(parseJoinTarget(`  ${ID}\n`)).toEqual({ roomId: ID, lineId: null });
  });

  it('takes the path this app serves', () => {
    expect(parseJoinTarget(`/room/${ID}`)).toEqual({ roomId: ID, lineId: null });
  });

  it('takes a whole link', () => {
    expect(parseJoinTarget(`https://arena.example.com/room/${ID}`)).toEqual({ roomId: ID, lineId: null });
  });

  it('keeps the variant a link names', () => {
    expect(parseJoinTarget(`https://arena.example.com/room/${ID}?line=${LINE}`)).toEqual({
      roomId: ID,
      lineId: LINE,
    });
  });

  it('keeps the variant from a path with no host in front of it', () => {
    expect(parseJoinTarget(`/room/${ID}?line=${LINE}`)).toEqual({ roomId: ID, lineId: LINE });
  });

  it('ignores the other parameters a room address carries', () => {
    // `?edit=1` is how the lobby opens a review for editing. It says nothing about which
    // room to enter, and a link carrying it must still enter the right one.
    expect(parseJoinTarget(`/room/${ID}?edit=1&line=${LINE}`)).toEqual({ roomId: ID, lineId: LINE });
  });

  it('reads a trailing slash as the same address', () => {
    expect(parseJoinTarget(`/room/${ID}/`)).toEqual({ roomId: ID, lineId: null });
  });

  it('refuses an empty box', () => {
    expect(parseJoinTarget('')).toBeNull();
    expect(parseJoinTarget('   ')).toBeNull();
  });

  it('refuses a link to some other page rather than entering it as a room id', () => {
    expect(parseJoinTarget('https://arena.example.com/tracker')).toBeNull();
  });

  it('refuses something with a space in it, which is a sentence and not an id', () => {
    expect(parseJoinTarget('the bracket review')).toBeNull();
  });
});
