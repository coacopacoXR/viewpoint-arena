import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcctImportResult } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { CAD_TESSELLATION_PARAMS } from '../cadImport';
import type { CadWorkerRequest, CadWorkerResponse } from '../cadImport';

// utils/cadWorker.ts is the piece that runs in production inside a Web Worker.
// Here it is imported into the test's own global scope, so dispatching a
// MessageEvent with a MessagePort drives exactly the code a browser would:
// pick the reader the request names, answer on the port that came with it.
// OpenCascade itself is faked — the real reader is covered against real files
// in cadImport.node.test.ts.

const readerState = vi.hoisted(() => ({
    reads: [] as string[],
    lastBytes: null as Uint8Array | null,
    throws: null as string | null
}));

const readerResult: OcctImportResult = {
    success: true,
    root: { name: 'Assembly', meshes: [0], children: [] },
    meshes: [{
        name: 'Part 1',
        brep_faces: [],
        attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
        index: { array: [0, 1, 2] }
    }]
};

let locateFile: ((path: string, scriptDirectory: string) => string) | null = null;

vi.mock('occt-import-js', () => ({
    default: (moduleArgs?: { locateFile?: (path: string, scriptDirectory: string) => string }) => {
        locateFile = moduleArgs?.locateFile ?? null;
        const readerFor = (name: string) => (content: Uint8Array) => {
            readerState.reads.push(name);
            readerState.lastBytes = content;
            if (readerState.throws) throw new Error(readerState.throws);
            return readerResult;
        };
        return Promise.resolve({
            ReadStepFile: readerFor('step'),
            ReadIgesFile: readerFor('iges'),
            ReadBrepFile: readerFor('brep')
        });
    }
}));

await import('../cadWorker');

/** Posts a request the way utils/cadImport.ts does, and waits for the reply. */
const askWorker = (request: CadWorkerRequest): Promise<CadWorkerResponse> => {
    const channel = new MessageChannel();
    const reply = new Promise<CadWorkerResponse>(resolve => {
        channel.port1.onmessage = (event: MessageEvent<CadWorkerResponse>) => resolve(event.data);
    });
    dispatchEvent(new MessageEvent('message', { data: request, ports: [channel.port2] }));
    return reply;
};

const request = (reader: CadWorkerRequest['reader'], bytes = new Uint8Array([7, 8, 9])): CadWorkerRequest => ({
    reader,
    bytes,
    params: CAD_TESSELLATION_PARAMS
});

beforeEach(() => {
    readerState.reads = [];
    readerState.lastBytes = null;
    readerState.throws = null;
});

describe('cadWorker', () => {
    it('uses the reader the request names', async () => {
        expect((await askWorker(request('step'))).ok).toBe(true);
        expect((await askWorker(request('iges'))).ok).toBe(true);
        expect((await askWorker(request('brep'))).ok).toBe(true);

        expect(readerState.reads).toEqual(['step', 'iges', 'brep']);
    });

    it('answers on the port that came with the request', async () => {
        const response = await askWorker(request('step'));

        expect(response).toEqual({ ok: true, result: readerResult });
        expect(Array.from(readerState.lastBytes ?? [])).toEqual([7, 8, 9]);
    });

    it('reports a reader failure instead of going quiet', async () => {
        readerState.throws = 'Aborted(OOM). Build with -s ASSERTIONS for more info.';

        const response = await askWorker(request('step'));

        expect(response.ok).toBe(false);
        if (response.ok === false) {
            expect(response.message).toContain('Aborted(OOM)');
        }
    });

    it('loads the WASM from the URL Vite gives it', async () => {
        await askWorker(request('step'));

        expect(locateFile).not.toBeNull();
        expect(locateFile!('occt-import-js.wasm', '/assets/')).toBe(wasmUrl);
        // Anything else the glue asks for is left to it.
        expect(locateFile!('something-else.js', '/assets/')).toBe('something-else.js');
    });
});
