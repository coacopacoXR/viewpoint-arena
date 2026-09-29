// Web Worker that tessellates CAD files with occt-import-js (OpenCascade
// compiled to WebAssembly, LGPL-2.1 — see THIRD_PARTY.md).
//
// Tessellating an assembly can take seconds, so it happens here rather than on
// the main thread: a big STEP file must not freeze the room. This module is
// loaded only when a CAD file is opened (utils/cadImport.ts creates the Worker
// lazily), and the WASM is a separate asset that Vite hands us a URL for.
//
// Requests arrive on the worker's own message event and are answered on the
// MessagePort that came with them, so each request has its own reply channel
// and utils/cadImport.ts never has to match responses to ids.

import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type { OcctImportResult, OcctInstance } from 'occt-import-js';
import type { CadWorkerRequest, CadWorkerResponse } from './cadImport';

let occtPromise: Promise<OcctInstance> | null = null;

/** The WASM is instantiated once per worker and reused for every file. */
const getOcct = (): Promise<OcctInstance> => {
    if (!occtPromise) {
        occtPromise = occtimportjs({
            locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path)
        });
    }
    return occtPromise;
};

const read = async (request: CadWorkerRequest): Promise<OcctImportResult> => {
    const occt = await getOcct();
    switch (request.reader) {
        case 'step':
            return occt.ReadStepFile(request.bytes, request.params);
        case 'iges':
            return occt.ReadIgesFile(request.bytes, request.params);
        case 'brep':
            return occt.ReadBrepFile(request.bytes, request.params);
        default:
            throw new Error(`cadWorker: no reader for '${String(request.reader)}'`);
    }
};

const messageOf = (error: unknown): string =>
    error instanceof Error && error.message.length > 0 ? error.message : 'The CAD reader failed unexpectedly.';

addEventListener('message', (event: MessageEvent<CadWorkerRequest>) => {
    const port = event.ports[0];
    if (!port) return;

    read(event.data).then(
        result => {
            const response: CadWorkerResponse = { ok: true, result };
            port.postMessage(response);
        },
        error => {
            const response: CadWorkerResponse = { ok: false, message: messageOf(error) };
            port.postMessage(response);
        }
    );
});
