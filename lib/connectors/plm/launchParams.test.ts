// Tests for the PLM launch deep-link parser (T5.3).
//
// The launch URL is attacker-influenced end to end — anyone can hand-edit one,
// and the template lives in a customer's PLM console — so the properties that
// matter are:
//
//   1. only the four known keys are ever read
//   2. an id that is not the shape its PLM issues is rejected, not normalised
//   3. no credential parameter survives into the result
//   4. an error message never repeats the rejected input (it is rendered on
//      screen and ends up in screenshots and support tickets)

import { describe, it, expect } from 'vitest';
import {
  parseLaunchParams,
  isLaunchError,
  stripCredentialParams,
  buildLaunchSearch,
  launchQuery,
  plmReferenceUrl,
  isOnshapeId,
  isGenericPlmId,
  isValidPlmId,
  PLM_SOURCE_LABELS,
} from './launchParams.ts';

// 24 lowercase hex characters, which is the only shape Onshape issues for a
// document, a workspace and an element alike.
const OS_DOC = 'a1b2c3d4e5f60718293a4b5c';
const OS_WS = 'fffffffffffffffffffffffe';
const OS_EL = '000000000000000000000001';

/** Narrow to the success variant, failing the test with the error if there is one. */
function expectOk(result: ReturnType<typeof parseLaunchParams>) {
  if (isLaunchError(result)) throw new Error(`expected success, got error: ${result.error}`);
  return result;
}

function expectError(result: ReturnType<typeof parseLaunchParams>): string {
  if (!isLaunchError(result)) {
    throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

describe('parseLaunchParams: valid links', () => {
  it('resolves a full Onshape link', () => {
    const result = expectOk(
      parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=${OS_WS}&plmElement=${OS_EL}`),
    );
    expect(result.source).toBe('onshape');
    expect(result.doc).toEqual({ id: OS_DOC, workspaceId: OS_WS, elementId: OS_EL });
  });

  it('resolves an Onshape link with only a document, and with a document + workspace', () => {
    const docOnly = expectOk(parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}`));
    expect(docOnly.doc.id).toBe(OS_DOC);
    expect(docOnly.doc.workspaceId).toBeUndefined();
    expect(docOnly.doc.elementId).toBeUndefined();

    const withWorkspace = expectOk(
      parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=${OS_WS}`),
    );
    expect(withWorkspace.doc).toEqual({ id: OS_DOC, workspaceId: OS_WS });
    expect(withWorkspace.doc.elementId).toBeUndefined();
  });

  it('resolves a Teamcenter link with opaque UIDs', () => {
    const result = expectOk(
      parseLaunchParams('?plmSource=teamcenter&plmDoc=TC-Item_12345&plmWorkspace=Rev.A&plmElement=PS-1'),
    );
    expect(result.source).toBe('teamcenter');
    expect(result.doc).toEqual({
      id: 'TC-Item_12345',
      workspaceId: 'Rev.A',
      elementId: 'PS-1',
    });
  });

  it('resolves a mock link', () => {
    const result = expectOk(parseLaunchParams('?plmSource=mock&plmDoc=mock-doc-1'));
    expect(result.source).toBe('mock');
    expect(result.doc).toEqual({ id: 'mock-doc-1' });
  });

  it('accepts a search string with no leading "?"', () => {
    const result = expectOk(parseLaunchParams(`plmSource=onshape&plmDoc=${OS_DOC}`));
    expect(result.doc.id).toBe(OS_DOC);
  });

  it('treats an empty optional parameter as absent, not as an invalid id', () => {
    const result = expectOk(
      parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=&plmElement=`),
    );
    expect(result.doc).toEqual({ id: OS_DOC });
  });
});

describe('parseLaunchParams: rejected ids', () => {
  const INJECTED = [
    '../../x',
    'a?b=c',
    'a/b',
    '%2F',
    '..%2F..%2Fetc%2Fpasswd',
    'x#fragment',
    'a\\b',
    'a b',
    'https://evil.example/x',
    'javascript:alert(1)',
    '',
    'a'.repeat(129),
  ];

  it.each(INJECTED)('rejects %j as an Onshape document id', (id) => {
    expect(isLaunchError(parseLaunchParams(`?plmSource=onshape&plmDoc=${id}`))).toBe(true);
  });

  it.each(INJECTED)('rejects %j as a Teamcenter document id', (id) => {
    // URLSearchParams decodes %2F to '/', so the encoded form is caught by the
    // same rule as the literal one.
    expect(isLaunchError(parseLaunchParams(`?plmSource=teamcenter&plmDoc=${id}`))).toBe(true);
  });

  it.each(INJECTED)('rejects %j as a mock document id', (id) => {
    expect(isLaunchError(parseLaunchParams(`?plmSource=mock&plmDoc=${id}`))).toBe(true);
  });

  it('rejects an injected workspace or element id even when the document is valid', () => {
    expectError(parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=../../x`));
    expectError(parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmElement=a%3Fb%3Dc`));
    expectError(parseLaunchParams('?plmSource=teamcenter&plmDoc=ok-doc&plmElement=a/b'));
  });

  it('rejects an Onshape id that is the right length but not lowercase hex', () => {
    expectError(parseLaunchParams('?plmSource=onshape&plmDoc=A1B2C3D4E5F60718293A4B5C'));
    expectError(parseLaunchParams('?plmSource=onshape&plmDoc=z1b2c3d4e5f60718293a4b5c'));
    expectError(parseLaunchParams('?plmSource=onshape&plmDoc=a1b2c3d4e5f60718293a4b5')); // 23
    expectError(parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}0`)); // 25
  });

  it('rejects a Teamcenter-shaped id offered as an Onshape one, and vice versa', () => {
    // A deployment's Onshape link must not accept the looser generic shape.
    expectError(parseLaunchParams('?plmSource=onshape&plmDoc=mock-doc-1'));
    // And the generic shape must not accept a 24-hex id with a slash in it.
    expectError(parseLaunchParams(`?plmSource=teamcenter&plmDoc=${OS_DOC}/x`));
  });

  it('rejects a missing or unknown source, and a missing document', () => {
    expectError(parseLaunchParams(`?plmDoc=${OS_DOC}`));
    expectError(parseLaunchParams(`?plmSource=solidworks&plmDoc=${OS_DOC}`));
    expectError(parseLaunchParams(`?plmSource=Onshape&plmDoc=${OS_DOC}`)); // case-sensitive
    expectError(parseLaunchParams('?plmSource=onshape'));
    expectError(parseLaunchParams('?plmSource=onshape&plmDoc='));
    expectError(parseLaunchParams(''));
  });

  it('never echoes the rejected input in an error message', () => {
    // Every one of these is invalid for all three sources, so all three produce
    // an error message — which is the text that gets rendered on screen.
    const hostile = [
      '../../etc/passwd',
      '<script>alert(1)</script>',
      'a?b=c',
      '%2F%2Fevil.example',
      'SUPER SECRET DOC ID',
    ];
    for (const id of hostile) {
      for (const source of ['onshape', 'teamcenter', 'mock', 'solidworks']) {
        const message = expectError(parseLaunchParams(`?plmSource=${source}&plmDoc=${id}`));
        expect(message).not.toContain(id);
        expect(message).not.toContain(encodeURIComponent(id));
        expect(message).not.toContain(source);
      }
    }
  });

  it('rejects a source that is not one of the three adapters', () => {
    expect(isLaunchError(parseLaunchParams('?plmSource=onshapee&plmDoc=x'))).toBe(true);
    expect(isLaunchError(parseLaunchParams('?plmSource=none&plmDoc=x'))).toBe(true);
  });
});

describe('parseLaunchParams: credentials and unknown keys', () => {
  it('drops a token and every other unknown key from the result', () => {
    const result = expectOk(
      parseLaunchParams(
        `?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=${OS_WS}&token=abc123&admin=true&next=//evil.example`,
      ),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('evil.example');
    expect(Object.keys(result)).toEqual(['source', 'doc']);
    expect(Object.keys(result.doc)).toEqual(['id', 'workspaceId']);
  });

  it('does not let a credential key masquerade as a document id', () => {
    // plmDoc is the only place an id can come from; a token cannot be promoted
    // into one, and the token value is never even read.
    const message = expectError(
      parseLaunchParams(`?plmSource=onshape&token=${OS_DOC}&access_token=${OS_DOC}`),
    );
    expect(message).not.toContain(OS_DOC);
  });

  it('launchQuery only re-emits the four known keys', () => {
    const result = expectOk(
      parseLaunchParams(`?plmSource=onshape&plmDoc=${OS_DOC}&plmElement=${OS_EL}&token=x`),
    );
    const query = launchQuery(result);
    expect(Object.keys(query).sort()).toEqual(['plmDoc', 'plmElement', 'plmSource']);
    expect(JSON.stringify(query)).not.toContain('token');
  });
});

describe('stripCredentialParams', () => {
  it('returns the input untouched when there is nothing to strip', () => {
    const search = `?plmSource=onshape&plmDoc=${OS_DOC}`;
    expect(stripCredentialParams(search)).toBe(search);
    expect(stripCredentialParams('')).toBe('');
  });

  it('removes a token and keeps the launch parameters', () => {
    const stripped = stripCredentialParams(`?plmSource=onshape&token=abc&plmDoc=${OS_DOC}`);
    expect(stripped).not.toContain('token');
    expect(stripped).not.toContain('abc');
    expect(stripped).toContain(`plmDoc=${OS_DOC}`);
    expect(stripped).toContain('plmSource=onshape');
    // Still parseable, and still the same launch.
    expect(expectOk(parseLaunchParams(stripped)).doc.id).toBe(OS_DOC);
  });

  it('removes every credential-shaped key, case-insensitively', () => {
    const stripped = stripCredentialParams(
      '?Token=a&ACCESS_TOKEN=b&apiKey=c&client_secret=d&Password=e&authorization=f&plmSource=mock&plmDoc=mock-doc-1',
    );
    for (const secret of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(stripped).not.toContain(`=${secret}`);
    }
    expect(stripped).toContain('plmSource=mock');
  });

  it('returns an empty string when the link carried nothing but a credential', () => {
    expect(stripCredentialParams('?token=abc')).toBe('');
  });
});

describe('buildLaunchSearch', () => {
  it('round-trips through parseLaunchParams', () => {
    const search = buildLaunchSearch('onshape', {
      id: OS_DOC,
      workspaceId: OS_WS,
      elementId: OS_EL,
    });
    const result = expectOk(parseLaunchParams(search));
    expect(result.source).toBe('onshape');
    expect(result.doc).toEqual({ id: OS_DOC, workspaceId: OS_WS, elementId: OS_EL });
  });

  it('omits the optional ids when they are absent', () => {
    expect(buildLaunchSearch('teamcenter', { id: 'tc-doc-1' })).toBe(
      '?plmSource=teamcenter&plmDoc=tc-doc-1',
    );
  });

  it('cannot emit a credential key', () => {
    // The signature only accepts a source and a document ref, so there is no
    // path by which a token could be rebuilt into a returnTo.
    const search = buildLaunchSearch('onshape', { id: OS_DOC });
    expect(Object.keys(Object.fromEntries(new URLSearchParams(search)))).toEqual([
      'plmSource',
      'plmDoc',
    ]);
  });
});

describe('plmReferenceUrl', () => {
  it('builds the full Onshape URL from the three validated ids', () => {
    expect(plmReferenceUrl('onshape', { id: OS_DOC, workspaceId: OS_WS, elementId: OS_EL })).toBe(
      `https://cad.onshape.com/documents/${OS_DOC}/w/${OS_WS}/e/${OS_EL}`,
    );
  });

  it('stops at whichever ids the link carried', () => {
    expect(plmReferenceUrl('onshape', { id: OS_DOC })).toBe(
      `https://cad.onshape.com/documents/${OS_DOC}`,
    );
    expect(plmReferenceUrl('onshape', { id: OS_DOC, workspaceId: OS_WS })).toBe(
      `https://cad.onshape.com/documents/${OS_DOC}/w/${OS_WS}`,
    );
    // An element without a workspace cannot be addressed, so it is not guessed.
    expect(plmReferenceUrl('onshape', { id: OS_DOC, elementId: OS_EL })).toBe(
      `https://cad.onshape.com/documents/${OS_DOC}`,
    );
  });

  it('builds no URL for a source whose document path this app does not know', () => {
    expect(plmReferenceUrl('teamcenter', { id: 'tc-doc-1' })).toBeUndefined();
    expect(plmReferenceUrl('mock', { id: 'mock-doc-1' })).toBeUndefined();
  });

  it('always produces an https URL on the Onshape host, whatever the ids', () => {
    // Defence in depth: parseLaunchParams already refused anything with a
    // separator in it, but this string is rendered into an href and saved into
    // the curation, so it is encoded again and asserted here.
    const hostile = [
      { id: 'a/b' },
      { id: 'javascript:alert(1)' },
      { id: OS_DOC, workspaceId: '../../x' },
      { id: OS_DOC, workspaceId: OS_WS, elementId: 'a?b=c' },
    ];
    for (const doc of hostile) {
      const url = plmReferenceUrl('onshape', doc);
      expect(url).toBeDefined();
      const parsed = new URL(url as string);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('cad.onshape.com');
    }
  });
});

describe('id shape predicates', () => {
  it('accepts only 24 lowercase hex characters as an Onshape id', () => {
    expect(isOnshapeId(OS_DOC)).toBe(true);
    expect(isOnshapeId('a1b2c3d4e5f60718293a4b5')).toBe(false); // 23
    expect(isOnshapeId(`${OS_DOC}a`)).toBe(false); // 25
    expect(isOnshapeId('A1B2C3D4E5F60718293A4B5C')).toBe(false);
    expect(isOnshapeId('a1b2c3d4e5f60718293a4b5g')).toBe(false);
    expect(isOnshapeId('')).toBe(false);
  });

  it('accepts opaque alphanumerics for Teamcenter and the mock, and nothing structural', () => {
    expect(isGenericPlmId('tc-doc_1.2-3')).toBe(true);
    for (const bad of ['a/b', 'a?b', 'a#b', 'a b', '%2F', 'a\\b', '', 'x'.repeat(129)]) {
      expect(isGenericPlmId(bad)).toBe(false);
    }
    // '.' and '..' ARE inside the documented shape — the rule is about the
    // character set, and a dot is legal in a Teamcenter UID. They are harmless
    // because a generic id is only ever placed in a query value that goes
    // through encodeURIComponent (TeamcenterPLMAdapter) or in no URL at all
    // (plmReferenceUrl returns undefined for anything but Onshape). A traversal
    // needs a '/', and that the shape rule does reject.
    expect(isGenericPlmId('..')).toBe(true);
    expect(isGenericPlmId('../../x')).toBe(false);
  });

  it('routes each source to its own rule', () => {
    expect(isValidPlmId('onshape', OS_DOC)).toBe(true);
    expect(isValidPlmId('onshape', 'tc-doc-1')).toBe(false);
    expect(isValidPlmId('teamcenter', 'tc-doc-1')).toBe(true);
    expect(isValidPlmId('mock', 'mock-doc-1')).toBe(true);
  });

  it('has a label for every source it accepts', () => {
    expect(Object.keys(PLM_SOURCE_LABELS).sort()).toEqual(['mock', 'onshape', 'teamcenter']);
  });
});
