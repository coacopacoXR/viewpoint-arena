// Who may change the models in a room — the one rule, asked from both sides.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH2, bug 2. party/room.server.ts
// has decided this by ROLE since batch BC; components/UI/SceneTree.tsx went on
// deciding it by "am I the meeting host". The owner of a review who made a
// colleague an editor, reloaded, and let that colleague arrive first was shown
// "Import locked" in their own review — by a client that disagreed with the
// server it was talking to.
//
// lib/scene/roomScene.scenePermissions is now the only place the answer is
// written down, and BOTH callers ask it. So the table below is exhaustive on
// purpose: role × "who may change models" × identity mode, plus the two edge
// people (nobody named as host yet, and a connection the room could not place).
// A row that changes here is a row that changed for the browser and the room
// server together, which is the point.

import { describe, expect, it } from 'vitest';
import { mayChangeModels, scenePermissions } from '../roomScene';
import type { ModelEditors, SceneAuthority } from '../roomScene';
import { ROLES, can } from '../../reviews/roles';
import type { Role } from '../../reviews/roles';

const ME = 'me';
const HOST = 'host-1';
const COLLEAGUE = 'colleague-1';

/** Every value the review's "who may change models" setting can hold. */
const SETTINGS: ReadonlyArray<{ name: string; editors: ModelEditors }> = [
  { name: 'host only', editors: 'host' },
  { name: 'everyone', editors: 'everyone' },
  { name: 'named, including me', editors: [ME, COLLEAGUE] },
  { name: 'named, without me', editors: [COLLEAGUE] },
  { name: 'named, nobody', editors: [] },
];

/** A person who is not the meeting host — the one bug 2 was about. */
function notHost(overrides: Partial<SceneAuthority> = {}): SceneAuthority {
  return { role: null, modelEditors: 'host', userId: ME, hostId: HOST, ...overrides };
}

function ask(authority: SceneAuthority) {
  return scenePermissions(authority);
}

// ─── identity.mode 'none': the host rule, unchanged ──────────────────────────

describe('scenePermissions — a deployment with no identities (role null)', () => {
  const PEOPLE = [
    { who: 'the host', userId: HOST as string | null, hostId: HOST as string | null },
    { who: 'somebody else', userId: ME as string | null, hostId: HOST as string | null },
    { who: 'somebody else, no host named yet', userId: ME as string | null, hostId: null },
    { who: 'a connection with no id, no host named', userId: null, hostId: null },
    { who: 'a connection with no id, a host named', userId: null, hostId: HOST as string | null },
  ];

  it('answers exactly what mayChangeModels answered, for every setting and person', () => {
    // This is what "keep today's host rule exactly" means, checked rather than
    // asserted in a comment: five settings × five people, against the function
    // batch BB shipped and the room server enforced.
    for (const setting of SETTINGS) {
      for (const person of PEOPLE) {
        const where = `${setting.name}, ${person.who}`;
        expect(
          ask({ role: null, modelEditors: setting.editors, userId: person.userId, hostId: person.hostId })
            .mayChangeModels,
          where,
        ).toBe(mayChangeModels(setting.editors, person.userId, person.hostId));
      }
    }
  });

  it('says "only the host" when the setting is host, and "not one of them" otherwise', () => {
    const hostOnly = ask(notHost({ role: null, modelEditors: 'host' }));
    expect(hostOnly.mayChangeModels).toBe(false);
    expect(hostOnly.changeRefusal).toBe('host-only');

    const named = ask(notHost({ role: null, modelEditors: [COLLEAGUE] }));
    expect(named.mayChangeModels).toBe(false);
    expect(named.changeRefusal).toBe('not-an-editor');
  });

  it('gives the host the setting, and nobody else', () => {
    for (const setting of SETTINGS) {
      expect(ask({ role: null, modelEditors: setting.editors, userId: HOST, hostId: HOST })
        .maySetModelEditors, setting.name).toBe(true);
      expect(ask({ role: null, modelEditors: setting.editors, userId: ME, hostId: HOST })
        .maySetModelEditors, setting.name).toBe(false);
    }
    // No host named yet is "you are the host" everywhere else in the app, but not
    // here: the room server has refused this message from a connection it could
    // not place since batch BB, and a client that offered the control would be
    // offering something the server would turn down.
    expect(ask({ role: null, modelEditors: 'host', userId: ME, hostId: null }).maySetModelEditors).toBe(false);
    expect(ask({ role: null, modelEditors: 'host', userId: null, hostId: null }).maySetModelEditors).toBe(false);
  });

  it('refuses with the no-accounts reason, whatever the role table would have said', () => {
    // A null role is not a role. On a default install there is no roster to read,
    // so the 'role-forbidden' wording — which sends somebody to ask the owner of
    // a review that has no owner — must never be the answer.
    const refusal = ask(notHost({ role: null })).changeRefusal;
    expect(refusal).not.toBe('role-forbidden');
    expect(refusal).not.toBe('role-forbidden-setting');
    expect(ask(notHost({ role: null })).editorsRefusal).toBe('host-only-setting');
  });
});

// ─── identities on: the role is the authority ────────────────────────────────

describe('scenePermissions — a deployment with accounts', () => {
  /** What the role table in lib/reviews/roles.ts already says, restated per setting. */
  it('lets owners and editors change the models, whatever the setting says', () => {
    for (const role of ['owner', 'editor'] as const) {
      for (const setting of SETTINGS) {
        const got = ask(notHost({ role, modelEditors: setting.editors }));
        expect(got.mayChangeModels, `${role}, ${setting.name}`).toBe(true);
        expect(got.changeRefusal, `${role}, ${setting.name}`).toBeNull();
      }
    }
  });

  it('still lets the setting widen it to participants and guests', () => {
    // 'everyone' and named people are the owner's choice to make, so a role that
    // may not edit the review is not a role that is locked out of the scene.
    for (const role of ['participant', 'guest'] as const) {
      for (const setting of SETTINGS) {
        const wanted = setting.editors === 'everyone'
          || (Array.isArray(setting.editors) && setting.editors.includes(ME));
        const got = ask(notHost({ role, modelEditors: setting.editors }));
        expect(got.mayChangeModels, `${role}, ${setting.name}`).toBe(wanted);
        expect(got.changeRefusal, `${role}, ${setting.name}`).toBe(wanted ? null : 'role-forbidden');
      }
    }
  });

  it('gives the setting to owners and editors, and to nobody else', () => {
    for (const role of ROLES) {
      const wanted = can(role, 'setModelEditors');
      for (const setting of SETTINGS) {
        const got = ask(notHost({ role, modelEditors: setting.editors }));
        expect(got.maySetModelEditors, `${role}, ${setting.name}`).toBe(wanted);
        expect(got.editorsRefusal, `${role}, ${setting.name}`).toBe(wanted ? null : 'role-forbidden-setting');
      }
    }
  });

  it('gives the role nothing extra for being the meeting host, and takes nothing away', () => {
    // The host is whoever arrived first, which on a deployment with accounts is
    // not an authority — a supplier's guest can be it. Holding the person constant
    // and moving the host around them must not move the answer, or the no-accounts
    // rule has been smuggled back in through hostId.
    for (const role of ROLES) {
      for (const setting of SETTINGS) {
        const asHost = ask({ role, modelEditors: setting.editors, userId: ME, hostId: ME });
        const asNot = ask({ role, modelEditors: setting.editors, userId: ME, hostId: HOST });
        expect(asHost.mayChangeModels, `${role}, ${setting.name}`).toBe(asNot.mayChangeModels);
        expect(asHost.maySetModelEditors, `${role}, ${setting.name}`).toBe(asNot.maySetModelEditors);
      }
    }
    // Said the other way round, because it is the half that surprises: hosting the
    // meeting does not let a participant into a review they have no role in.
    expect(ask({ role: 'participant', modelEditors: 'host', userId: HOST, hostId: HOST }).mayChangeModels).toBe(false);
    // And not being the host does not lock the owner out — bug 2.
    expect(ask({ role: 'owner', modelEditors: 'host', userId: ME, hostId: HOST }).mayChangeModels).toBe(true);
  });

  it('reads a connection it has no id for as nobody in particular', () => {
    // A null userId is a connection that has not identified itself. It is not the
    // person the setting names, and it is not the host — so only a setting that
    // means "everybody", or a role that carries the right on its own, lets it in.
    expect(ask({ role: 'owner', modelEditors: 'host', userId: null, hostId: HOST }).mayChangeModels).toBe(true);
    expect(ask({ role: 'participant', modelEditors: [ME], userId: null, hostId: HOST }).mayChangeModels).toBe(false);
    expect(ask({ role: 'participant', modelEditors: 'everyone', userId: null, hostId: HOST }).mayChangeModels).toBe(true);
    expect(ask({ role: 'participant', modelEditors: 'host', userId: null, hostId: HOST }).mayChangeModels).toBe(false);
  });

  // ─── The bug this batch was opened for ─────────────────────────────────────

  it('lets the owner of a review import into it when somebody else is the host', () => {
    // Reproduced live: the owner created the review, made a colleague an editor in
    // People, reloaded, and the colleague — arriving first — became the meeting
    // host. The owner's model tree said "Import locked" while the room server
    // would have allowed the import.
    const owner = ask({ role: 'owner', modelEditors: 'host', userId: ME, hostId: HOST });
    expect(owner.mayChangeModels).toBe(true);
    expect(owner.changeRefusal).toBeNull();
    // And the control that decides who else may, which the same owner had also
    // lost, because it was gated on being the host.
    expect(owner.maySetModelEditors).toBe(true);

    // The colleague they made an editor is in the same position.
    expect(ask({ role: 'editor', modelEditors: 'host', userId: COLLEAGUE, hostId: HOST }).mayChangeModels).toBe(true);
  });

  it('leaves a guest of the review locked out of a review that is not theirs', () => {
    // The direction the rule exists for: a supplier in somebody else's design
    // review must not be able to swap the product under discussion, however they
    // arrived and whoever is hosting.
    const guest = ask({ role: 'guest', modelEditors: 'host', userId: ME, hostId: HOST });
    expect(guest.mayChangeModels).toBe(false);
    expect(guest.changeRefusal).toBe('role-forbidden');
    expect(guest.maySetModelEditors).toBe(false);
  });
});

// ─── The two answers agree with each other ───────────────────────────────────

describe('scenePermissions — one answer, two spellings', () => {
  const AUTHORITIES: SceneAuthority[] = [
    ...SETTINGS.flatMap((setting) => [
      { role: null, modelEditors: setting.editors, userId: ME, hostId: HOST },
      { role: null, modelEditors: setting.editors, userId: HOST, hostId: HOST },
      ...ROLES.map((role: Role) => ({
        role,
        modelEditors: setting.editors,
        userId: ME,
        hostId: HOST,
      })),
    ]),
  ];

  it('says "may" exactly when it has no reason to refuse', () => {
    // A boolean and a reason that could disagree is two answers, and the client
    // reads one while the server reads the other.
    for (const authority of AUTHORITIES) {
      const got = ask(authority);
      expect(got.mayChangeModels).toBe(got.changeRefusal === null);
      expect(got.maySetModelEditors).toBe(got.editorsRefusal === null);
    }
  });

  it('never lets somebody set the setting who may not change the models under it', () => {
    // Handing out a power is a step above holding it: anybody who may decide that
    // everybody may change the models could have decided that for themselves.
    for (const authority of AUTHORITIES) {
      const got = ask(authority);
      if (got.maySetModelEditors) {
        expect(got.mayChangeModels).toBe(true);
      }
    }
  });
});
