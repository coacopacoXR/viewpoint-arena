// Tests for OnshapeBrowser.
//
// Two things are pinned here:
//
//   1. WITHOUT the launch props the component behaves exactly as it did before
//      T5.3 — session check, document list, element picker, import. There was no
//      test for this component before, so these are the regression net for the
//      props added by the PLM deep link.
//   2. WITH the launch props it follows the link: straight to the linked
//      document, importing the linked element using the type the Onshape API
//      reports (never one taken from the URL), and falling back to the picker
//      when the link cannot be honoured.
//
// The real lib/onshape.ts wrappers run against a stubbed global fetch, so the
// request URLs are asserted too.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import OnshapeBrowser from '../OnshapeBrowser';

interface StubRoutes {
  /** null (or omitted) means "no Onshape session". */
  me?: Record<string, unknown> | null;
  documents?: unknown;
  elements?: unknown;
  translate?: { status: number; body: string };
}

function stubOnshapeApi(routes: StubRoutes) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/onshape/me')) {
      return routes.me
        ? new Response(JSON.stringify(routes.me), { status: 200 })
        : new Response(JSON.stringify({ error: 'not_authenticated' }), { status: 401 });
    }
    if (url.startsWith('/api/onshape/documents')) {
      return new Response(JSON.stringify(routes.documents ?? { items: [] }), { status: 200 });
    }
    if (url.startsWith('/api/onshape/elements')) {
      return new Response(
        JSON.stringify(routes.elements ?? { items: [], allTypes: [] }),
        { status: 200 },
      );
    }
    if (url.startsWith('/api/onshape/translate')) {
      return new Response(routes.translate?.body ?? '{}', {
        status: routes.translate?.status ?? 200,
      });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls };
}

const started = (urls: string[]) => urls.find((u) => u.startsWith('/api/onshape/translate?'));
const elementsCall = (urls: string[]) => urls.find((u) => u.startsWith('/api/onshape/elements'));
const documentsCall = (urls: string[]) => urls.find((u) => u.startsWith('/api/onshape/documents'));

function paramsOf(url: string | undefined): URLSearchParams {
  return new URL(url ?? '', 'http://localhost').searchParams;
}

const DOC = {
  id: 'doc1',
  name: 'Bracket Assembly',
  modifiedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  defaultWorkspaceId: 'ws1',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OnshapeBrowser without the launch props', () => {
  it('shows the sign-in step and never fetches documents when there is no session', async () => {
    const { urls } = stubOnshapeApi({ me: null });

    render(<OnshapeBrowser onClose={() => {}} onImported={() => {}} />);

    expect(
      await screen.findByRole('button', { name: /connect onshape/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sign in with Onshape/i)).toBeInTheDocument();
    expect(documentsCall(urls)).toBeUndefined();
  });

  it('lists documents, then elements, then imports the picked element', async () => {
    const { urls } = stubOnshapeApi({
      me: { name: 'Alex Chen' },
      documents: { items: [DOC] },
      elements: {
        items: [{ id: 'el1', name: 'Main Assembly', type: 'ASSEMBLY' }],
        allTypes: ['ASSEMBLY'],
      },
      translate: { status: 500, body: 'kaboom' },
    });

    render(<OnshapeBrowser onClose={() => {}} onImported={() => {}} />);

    fireEvent.click(await screen.findByText('Bracket Assembly'));
    const elementsUrl = elementsCall(urls);
    expect(paramsOf(elementsUrl).get('d')).toBe('doc1');
    expect(paramsOf(elementsUrl).get('w')).toBe('ws1');

    fireEvent.click(await screen.findByText('Main Assembly'));
    const translateUrl = started(urls);
    expect(paramsOf(translateUrl).get('e')).toBe('el1');
    expect(paramsOf(translateUrl).get('type')).toBe('ASSEMBLY');

    // A failed import returns to the picker with the reason, as before.
    expect(await screen.findByText(/Onshape import failed \(500\)/)).toBeInTheDocument();
    expect(await screen.findByText('Main Assembly')).toBeInTheDocument();
  });

  it('explains a document that has no default workspace', async () => {
    stubOnshapeApi({
      me: { name: 'Alex Chen' },
      documents: { items: [{ ...DOC, defaultWorkspaceId: undefined }] },
    });

    render(<OnshapeBrowser onClose={() => {}} onImported={() => {}} />);
    fireEvent.click(await screen.findByText('Bracket Assembly'));

    expect(await screen.findByText(/no default workspace/i)).toBeInTheDocument();
  });
});

describe('OnshapeBrowser in launch mode', () => {
  it('imports the linked element directly, taking its type from the API', async () => {
    const { urls } = stubOnshapeApi({
      me: { name: 'Alex Chen' },
      elements: {
        items: [{ id: 'el2', name: 'Housing Studio', type: 'PARTSTUDIO' }],
        allTypes: ['PARTSTUDIO'],
      },
      translate: { status: 500, body: 'kaboom' },
    });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1', workspaceId: 'ws1' }}
        initialElementId="el2"
      />,
    );

    expect(await screen.findByText(/Onshape import failed \(500\)/)).toBeInTheDocument();

    // It went straight at the linked document: no document-list fetch.
    expect(documentsCall(urls)).toBeUndefined();
    expect(paramsOf(elementsCall(urls)).get('d')).toBe('doc1');
    expect(paramsOf(elementsCall(urls)).get('w')).toBe('ws1');
    // The link carried only an id — ASSEMBLY vs PARTSTUDIO came from the API.
    expect(paramsOf(started(urls)).get('e')).toBe('el2');
    expect(paramsOf(started(urls)).get('type')).toBe('PARTSTUDIO');
  });

  it('falls back to the element picker when the linked element is not in the document', async () => {
    const { urls } = stubOnshapeApi({
      me: { name: 'Alex Chen' },
      elements: {
        items: [{ id: 'el9', name: 'Something Else', type: 'ASSEMBLY' }],
        allTypes: ['ASSEMBLY'],
      },
    });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1', workspaceId: 'ws1' }}
        initialElementId="el-moved-away"
      />,
    );

    expect(await screen.findByText(/not in this document/i)).toBeInTheDocument();
    expect(await screen.findByText('Something Else')).toBeInTheDocument();
    expect(started(urls)).toBeUndefined();
  });

  it('shows the picker for a document launched without an element', async () => {
    const { urls } = stubOnshapeApi({
      me: { name: 'Alex Chen' },
      elements: {
        items: [{ id: 'el1', name: 'Main Assembly', type: 'ASSEMBLY' }],
        allTypes: ['ASSEMBLY'],
      },
    });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1', workspaceId: 'ws1' }}
      />,
    );

    expect(await screen.findByText(/pick an assembly or part studio/i)).toBeInTheDocument();
    expect(await screen.findByText('Main Assembly')).toBeInTheDocument();
    expect(started(urls)).toBeUndefined();
  });

  it('resolves a missing workspace from the document list, as the picker does', async () => {
    const { urls } = stubOnshapeApi({
      me: { name: 'Alex Chen' },
      documents: { items: [{ ...DOC, defaultWorkspaceId: 'ws-default' }] },
      elements: {
        items: [{ id: 'el1', name: 'Main Assembly', type: 'ASSEMBLY' }],
        allTypes: ['ASSEMBLY'],
      },
    });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1' }}
      />,
    );

    expect(await screen.findByText(/pick an assembly or part studio/i)).toBeInTheDocument();
    expect(paramsOf(elementsCall(urls)).get('w')).toBe('ws-default');
  });

  it('explains and shows the document list when no workspace can be resolved', async () => {
    stubOnshapeApi({
      me: { name: 'Alex Chen' },
      documents: {
        items: [{ ...DOC, id: 'some-other-doc', name: 'Other Document', defaultWorkspaceId: undefined }],
      },
    });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1' }}
      />,
    );

    expect(await screen.findByText(/did not name a workspace/i)).toBeInTheDocument();
    // The user is left somewhere useful: the document list, ready to search.
    expect(await screen.findByPlaceholderText(/search your documents/i)).toBeInTheDocument();
    // findBy, not getBy: the list loads asynchronously after the search box
    // renders, so a synchronous query races it (failed on the slower CI runner).
    expect(await screen.findByText('Other Document')).toBeInTheDocument();
  });

  it('still requires a session: a launch with no Onshape sign-in shows the auth step', async () => {
    const { urls } = stubOnshapeApi({ me: null });

    render(
      <OnshapeBrowser
        onClose={() => {}}
        onImported={() => {}}
        initialDocument={{ id: 'doc1', workspaceId: 'ws1' }}
        initialElementId="el2"
      />,
    );

    expect(
      await screen.findByRole('button', { name: /connect onshape/i }),
    ).toBeInTheDocument();
    expect(elementsCall(urls)).toBeUndefined();
    expect(started(urls)).toBeUndefined();
  });
});
