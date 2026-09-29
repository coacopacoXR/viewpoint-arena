import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcctImportResult } from 'occt-import-js';
import type { CadWorkerRequest, CadWorkerResponse } from '../cadImport';

// jsdom has no Worker, so the client is tested against a stand-in that speaks
// the same protocol over a real MessageChannel: post the request, answer on the
// port that came with it. That keeps the timeout, crash and failure paths — the
// ones that must never leave an import spinner running — under test.

type Responder = (request: CadWorkerRequest, port: MessagePort) => void;

let responder: Responder = () => {
    /* answer nothing: the caller should time out */
};

class FakeWorker {
    static instances: FakeWorker[] = [];

    terminated = false;
    requests: CadWorkerRequest[] = [];
    private errorListeners: Array<(event: ErrorEvent) => void> = [];

    constructor(readonly scriptUrl: string | URL, readonly workerOptions?: WorkerOptions) {
        FakeWorker.instances.push(this);
    }

    addEventListener(type: string, listener: (event: ErrorEvent) => void) {
        if (type === 'error') this.errorListeners.push(listener);
    }

    removeEventListener(type: string, listener: (event: ErrorEvent) => void) {
        if (type === 'error') {
            this.errorListeners = this.errorListeners.filter(kept => kept !== listener);
        }
    }

    postMessage(request: CadWorkerRequest, transfer: Transferable[]) {
        this.requests.push(request);
        const port = transfer.find(item => item instanceof MessagePort);
        if (port) responder(request, port);
    }

    terminate() {
        this.terminated = true;
    }

    /** What an uncaught exception in the worker looks like from outside. */
    crash() {
        this.errorListeners.forEach(listener => listener(new ErrorEvent('error', { message: 'out of memory' })));
    }
}

const okResult = (meshes = 1): OcctImportResult => ({
    success: true,
    root: { name: 'Assembly', meshes: meshes > 0 ? [0] : [], children: [] },
    meshes: Array.from({ length: meshes }, (_, index) => ({
        name: `Part ${index + 1}`,
        brep_faces: [],
        attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
        index: { array: [0, 1, 2] }
    }))
});

const answerWith = (response: CadWorkerResponse): void => {
    responder = (_request, port) => port.postMessage(response);
};

const stepFile = (contents = 'ISO-10303-21;'): File => new File([contents], 'bracket.step', { type: 'model/step' });

const lastWorker = (): FakeWorker => FakeWorker.instances[FakeWorker.instances.length - 1];

let client: typeof import('../cadImport');

beforeEach(async () => {
    FakeWorker.instances = [];
    responder = (_request, port) => port.postMessage({ ok: true, result: okResult() } satisfies CadWorkerResponse);
    vi.stubGlobal('Worker', FakeWorker);
    vi.resetModules();
    client = await import('../cadImport');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('readCadFile', () => {
    it('creates no worker until a CAD file is actually read', async () => {
        expect(FakeWorker.instances).toHaveLength(0);
        expect(client.CAD_IMPORT_TIMEOUT_MS).toBe(3 * 60 * 1000);

        await client.readCadFile(stepFile(), 'step');

        expect(FakeWorker.instances).toHaveLength(1);
    });

    it('hands the worker the file bytes, the reader and the tessellation params', async () => {
        const result = await client.readCadFile(stepFile('ISO-10303-21;'), 'iges');

        expect(result.success).toBe(true);
        const request = lastWorker().requests[0];
        expect(request.reader).toBe('iges');
        expect(request.params).toEqual(client.CAD_TESSELLATION_PARAMS);
        expect(new TextDecoder().decode(request.bytes)).toBe('ISO-10303-21;');
    });

    it('reuses one worker for the next file', async () => {
        await client.readCadFile(stepFile(), 'step');
        await client.readCadFile(stepFile(), 'step');

        expect(FakeWorker.instances).toHaveLength(1);
        expect(lastWorker().requests).toHaveLength(2);
        expect(lastWorker().terminated).toBe(false);
    });

    it('rejects with the plain message when the reader reports failure', async () => {
        answerWith({ ok: true, result: { ...okResult(), success: false } });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(client.readCadFile(stepFile(), 'step')).rejects.toThrow(client.cadReadFailureMessage('step'));
        expect(consoleError).not.toHaveBeenCalled();
        // The reader answered, so the worker stays warm.
        expect(lastWorker().terminated).toBe(false);
    });

    it('rejects on an empty result rather than showing nothing', async () => {
        answerWith({ ok: true, result: okResult(0) });

        await expect(client.readCadFile(stepFile(), 'brep')).rejects.toThrow(client.cadReadFailureMessage('brep'));
    });

    it('rejects with the same plain message when the worker itself throws', async () => {
        answerWith({ ok: false, message: 'Aborted(OOM). Build with -s ASSERTIONS for more info.' });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(client.readCadFile(stepFile(), 'step')).rejects.toThrow(client.cadReadFailureMessage('step'));
        // The detail is logged, not shown to the reviewer.
        expect(consoleError).toHaveBeenCalled();
    });

    it('rejects when the worker dies, and replaces it next time', async () => {
        responder = () => {
            lastWorker().crash();
        };

        await expect(client.readCadFile(stepFile(), 'step')).rejects.toThrow(client.cadCrashMessage('step'));
        expect(lastWorker().terminated).toBe(true);

        responder = (_request, port) => port.postMessage({ ok: true, result: okResult() } satisfies CadWorkerResponse);
        await expect(client.readCadFile(stepFile(), 'step')).resolves.toEqual(okResult());
        expect(FakeWorker.instances).toHaveLength(2);
    });

    it('gives up after three minutes instead of hanging', async () => {
        vi.useFakeTimers();
        responder = () => undefined;

        const pending = client.readCadFile(stepFile(), 'step');
        // Attach the handler before the clock runs, or Node sees the rejection
        // as unhandled for a moment.
        const assertion = expect(pending).rejects.toThrow(client.cadTimeoutMessage('step'));
        await vi.advanceTimersByTimeAsync(client.CAD_IMPORT_TIMEOUT_MS);

        await assertion;
        expect(lastWorker().terminated).toBe(true);
    });

    it('says which format the message is about', () => {
        expect(client.cadReadFailureMessage('step')).toBe(
            'Could not read this STEP file. If it came from a CAD system, re-export it as STEP AP214 or AP242.'
        );
        expect(client.cadReadFailureMessage('iges')).toContain('IGES');
        expect(client.cadReadFailureMessage('brep')).toContain('BREP');
    });
});
