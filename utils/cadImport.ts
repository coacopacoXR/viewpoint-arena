// Main-thread side of a CAD import: owns the lazily created Web Worker, the
// time limit, and the plain-language errors.
//
// Nothing of OpenCascade is fetched until readCadFile() runs. The Worker — and
// with it the 7.6 MB occt-import-js.wasm — is created inside the function, not
// at module scope, so opening a GLB never pays for it.

import type { OcctImportResult, OcctTessellationParams } from 'occt-import-js';

export type CadReaderKind = 'step' | 'iges' | 'brep';

/**
 * How finely OpenCascade tessellates: fine enough for design review, coarse
 * enough that a large assembly finishes instead of grinding. Exported so the
 * real-file test asserts against what the worker actually sends.
 */
export const CAD_TESSELLATION_PARAMS: OcctTessellationParams = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5
};

/** Which OpenCascade reader an extension needs. Keys mirror CAD_EXTENSIONS. */
export const CAD_READER_BY_EXTENSION: Record<string, CadReaderKind> = {
    '.step': 'step',
    '.stp': 'step',
    '.iges': 'iges',
    '.igs': 'iges',
    '.brep': 'brep',
    '.brp': 'brep'
};

export const CAD_READER_LABEL: Record<CadReaderKind, string> = {
    step: 'STEP',
    iges: 'IGES',
    brep: 'BREP'
};

/** Tessellating a large assembly is slow, but three minutes means it is stuck. */
export const CAD_IMPORT_TIMEOUT_MS = 3 * 60 * 1000;

export interface CadWorkerRequest {
    reader: CadReaderKind;
    bytes: Uint8Array;
    params: OcctTessellationParams;
}

export type CadWorkerResponse =
    | { ok: true; result: OcctImportResult }
    | { ok: false; message: string };

export const cadReadFailureMessage = (reader: CadReaderKind): string =>
    `Could not read this ${CAD_READER_LABEL[reader]} file. If it came from a CAD system, ` +
    're-export it as STEP AP214 or AP242.';

export const cadTimeoutMessage = (reader: CadReaderKind): string =>
    `Reading this ${CAD_READER_LABEL[reader]} file took longer than ` +
    `${Math.round(CAD_IMPORT_TIMEOUT_MS / 60000)} minutes and was cancelled. ` +
    'Try a smaller assembly, or export it with a coarser tessellation.';

export const cadCrashMessage = (reader: CadReaderKind): string =>
    `The CAD reader stopped while opening this ${CAD_READER_LABEL[reader]} file. ` +
    'Re-export it as STEP AP214 or AP242 and try again.';

let worker: Worker | null = null;

const dropWorker = () => {
    worker?.terminate();
    worker = null;
};

const getWorker = (): Worker => {
    if (!worker) {
        worker = new Worker(new URL('./cadWorker.ts', import.meta.url), { type: 'module' });
    }
    return worker;
};

/**
 * Reads one CAD file. Resolves with the raw occt-import-js result; rejects with
 * a message a reviewer can act on if the reader fails, returns nothing usable,
 * crashes, or exceeds CAD_IMPORT_TIMEOUT_MS. Every path settles, so no caller
 * can be left waiting.
 */
export const readCadFile = async (file: File, reader: CadReaderKind): Promise<OcctImportResult> => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const channel = new MessageChannel();
    const port = channel.port1;
    const cadWorker = getWorker();

    try {
        return await new Promise<OcctImportResult>((resolve, reject) => {
            function cleanup() {
                clearTimeout(timer);
                cadWorker.removeEventListener('error', onWorkerError);
                port.removeEventListener('message', onMessage);
                port.removeEventListener('messageerror', onMessageError);
            }

            function failWith(message: string, wedged: boolean) {
                cleanup();
                // A worker that timed out or threw is not trusted with the next file.
                if (wedged) dropWorker();
                reject(new Error(message));
            }

            function onMessage(event: MessageEvent<CadWorkerResponse>) {
                // Anything at all can come off a worker, so treat it as untrusted.
                const response: CadWorkerResponse | undefined = event.data;
                const result = response && response.ok === true ? response.result : undefined;

                if (result?.success && (result.meshes?.length ?? 0) > 0) {
                    cleanup();
                    resolve(result);
                    return;
                }

                if (response && response.ok === false) {
                    // The worker caught something (a WASM failure, an OCCT
                    // exception). The detail goes to the console; the reviewer
                    // gets the same plain message either way.
                    console.error('[cadImport] reader failed:', response.message);
                }

                // The reader answered, so the worker is healthy: keep it warm for
                // the next file rather than paying for the WASM again.
                failWith(cadReadFailureMessage(reader), false);
            }

            function onWorkerError() {
                failWith(cadCrashMessage(reader), true);
            }

            function onMessageError() {
                failWith(cadReadFailureMessage(reader), true);
            }

            const timer = setTimeout(() => failWith(cadTimeoutMessage(reader), true), CAD_IMPORT_TIMEOUT_MS);
            // The worker imports nothing from here at runtime — only its types —
            // so it stays a leaf and the params live in exactly one place.
            const request: CadWorkerRequest = { reader, bytes, params: CAD_TESSELLATION_PARAMS };

            port.addEventListener('message', onMessage);
            port.addEventListener('messageerror', onMessageError);
            cadWorker.addEventListener('error', onWorkerError);
            port.start();
            cadWorker.postMessage(request, [buffer, channel.port2]);
        });
    } finally {
        port.close();
    }
};
