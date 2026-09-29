import { describe, it, expect } from 'vitest';
import { TYPE_INT_TO_STR as ADAPTER_MAP, normalizeElementType } from './onshape.ts';
import { TYPE_INT_TO_STR as HANDLER_MAP, normalizeType } from '../../../api/onshape/elements.ts';

// The adapter deliberately keeps its own copy of Onshape's element-type
// normalization instead of importing the Vercel handler module. That is a
// drift hazard: if Onshape adds an element type and only one copy is updated,
// the adapter and the live endpoint would silently disagree about what a
// document contains. These tests turn that silent divergence into a CI failure.
describe('Onshape element-type mapping stays in sync', () => {
  it('has identical integer->string maps in adapter and handler', () => {
    expect(ADAPTER_MAP).toEqual(HANDLER_MAP);
  });

  it('normalizes identically across every known input shape', () => {
    const base = { id: 'e1', name: 'Element' };
    const cases: Array<{
      id: string;
      name: string;
      elementType?: string;
      type?: string | number;
    }> = [
      { ...base, elementType: 'assembly' },
      { ...base, elementType: 'Part Studio' },
      { ...base, type: 'DRAWING' },
      { ...base, type: 0 },
      { ...base, type: 1 },
      { ...base, type: 9 },
      { ...base, type: 42 },
      { ...base },
    ];
    for (const c of cases) {
      expect(normalizeElementType(c)).toBe(normalizeType(c));
    }
  });
});
