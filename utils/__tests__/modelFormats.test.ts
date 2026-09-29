import { describe, expect, it } from 'vitest';
import { validateModelFile } from '../modelLoader';
import { CAD_READER_BY_EXTENSION, CAD_READER_LABEL } from '../cadImport';
import {
    CAD_EXTENSIONS,
    DEFAULT_UP_AXIS,
    INVALID_FILE_TYPE_MESSAGE,
    MESH_EXTENSIONS,
    MODEL_FILE_ACCEPT,
    MODEL_MIME_TYPES,
    NATIVE_CAD_EXTENSIONS,
    NATIVE_CAD_MESSAGE,
    SUPPORTED_EXTENSIONS,
    UP_AXIS_BY_EXTENSION,
    maxFileSizeFor,
    modelFileExtension,
    modelFileMime,
    upAxisFor
} from '../modelFormats';

/** A File that claims to be `size` bytes without allocating them. */
const fileSized = (name: string, size: number): File => {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'size', { value: size });
    return file;
};

const MB = 1024 * 1024;

describe('the one shared format list', () => {
    it('is mesh formats plus CAD formats, with no duplicates or overlap', () => {
        expect(SUPPORTED_EXTENSIONS).toEqual([...MESH_EXTENSIONS, ...CAD_EXTENSIONS]);
        expect(new Set(SUPPORTED_EXTENSIONS).size).toBe(SUPPORTED_EXTENSIONS.length);
        expect(MESH_EXTENSIONS.some(ext => CAD_EXTENSIONS.includes(ext))).toBe(false);
    });

    it('drives the file pickers accept attribute', () => {
        const tokens = MODEL_FILE_ACCEPT.split(',');

        expect(tokens).toHaveLength(SUPPORTED_EXTENSIONS.length * 2);
        for (const ext of SUPPORTED_EXTENSIONS) {
            expect(tokens).toContain(ext);
            expect(tokens).toContain(ext.toUpperCase());
        }
        // Nothing in the picker that the loader would then refuse.
        expect(new Set(tokens.map(token => token.toLowerCase()))).toEqual(new Set(SUPPORTED_EXTENSIONS));
    });

    it('drives the unsupported-type message', () => {
        for (const ext of SUPPORTED_EXTENSIONS) {
            expect(INVALID_FILE_TYPE_MESSAGE).toContain(ext.slice(1).toUpperCase());
        }
    });

    it('gives every supported extension a MIME type', () => {
        for (const ext of SUPPORTED_EXTENSIONS) {
            expect(MODEL_MIME_TYPES[ext], ext).toBeTruthy();
        }

        expect(modelFileMime('assembly.STEP')).toBe('model/step');
        expect(modelFileMime('scan.ply')).toBe('application/octet-stream');
        expect(modelFileMime('mystery.bin')).toBe('application/octet-stream');
        expect(modelFileMime('README')).toBe('application/octet-stream');
    });

    it('maps every CAD extension onto a reader, and every reader onto a label', () => {
        expect(new Set(Object.keys(CAD_READER_BY_EXTENSION))).toEqual(new Set(CAD_EXTENSIONS));
        for (const reader of Object.values(CAD_READER_BY_EXTENSION)) {
            expect(CAD_READER_LABEL[reader]).toBeTruthy();
        }
    });
});

describe('up axis', () => {
    it('is Z for CAD and Y for everything else', () => {
        for (const ext of CAD_EXTENSIONS) {
            expect(upAxisFor(ext)).toBe('z');
        }
        for (const ext of MESH_EXTENSIONS) {
            expect(upAxisFor(ext)).toBe('y');
        }
        expect(upAxisFor('.zip')).toBe(DEFAULT_UP_AXIS);
        expect(new Set(Object.keys(UP_AXIS_BY_EXTENSION))).toEqual(new Set(CAD_EXTENSIONS));
    });
});

describe('extensionOf a file name', () => {
    it('is lower case and dotted', () => {
        expect(modelFileExtension('Assembly.STEP')).toBe('.step');
        expect(modelFileExtension('archive.tar.gz')).toBe('.gz');
    });

    it('is empty when there is no extension to dispatch on', () => {
        expect(modelFileExtension('README')).toBe('');
        expect(modelFileExtension('.gitignore')).toBe('');
    });
});

describe('validateModelFile', () => {
    it('accepts every supported format', () => {
        for (const ext of SUPPORTED_EXTENSIONS) {
            expect(validateModelFile(fileSized(`model${ext}`, MB)), ext).toBeNull();
        }
    });

    it('refuses anything else', () => {
        expect(validateModelFile(fileSized('notes.zip', MB))).toBe(INVALID_FILE_TYPE_MESSAGE);
        expect(validateModelFile(fileSized('README', MB))).toBe(INVALID_FILE_TYPE_MESSAGE);
        expect(validateModelFile(fileSized('model.stpz', MB))).toBe(INVALID_FILE_TYPE_MESSAGE);
    });

    it('points a native CAD file at a STEP export instead', () => {
        for (const ext of NATIVE_CAD_EXTENSIONS) {
            expect(validateModelFile(fileSized(`part${ext}`, MB)), ext).toBe(NATIVE_CAD_MESSAGE);
        }

        // Recognised for the message only: never offered in a picker.
        for (const ext of NATIVE_CAD_EXTENSIONS) {
            expect(SUPPORTED_EXTENSIONS).not.toContain(ext);
            expect(MODEL_FILE_ACCEPT.split(',')).not.toContain(ext);
        }
    });

    it('allows a bigger file for CAD than for mesh formats', () => {
        expect(maxFileSizeFor('.step')).toBe(200 * MB);
        expect(maxFileSizeFor('.glb')).toBe(50 * MB);

        expect(validateModelFile(fileSized('assembly.step', 199 * MB))).toBeNull();
        expect(validateModelFile(fileSized('assembly.stp', 51 * MB))).toBeNull();
        expect(validateModelFile(fileSized('assembly.glb', 49 * MB))).toBeNull();

        expect(validateModelFile(fileSized('assembly.glb', 51 * MB))).toMatch(/too large/i);
        expect(validateModelFile(fileSized('assembly.glb', 51 * MB))).toContain('50MB');
        expect(validateModelFile(fileSized('assembly.step', 201 * MB))).toContain('200MB');
    });
});
