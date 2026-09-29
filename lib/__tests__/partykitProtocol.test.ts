import { describe, it, expect } from 'vitest';
import { partykitProtocol } from '../usePartyPresence';

describe('partykitProtocol', () => {
  it('forces wss on an https page, whatever the PartyKit host looks like', () => {
    // partysocket would otherwise pick ws:// for localhost:/192.168./10. hosts,
    // which is exactly what the self-hosted stack uses (https://localhost/).
    expect(partykitProtocol('https:')).toBe('wss');
  });

  it('leaves the choice to partysocket on http (local `partykit dev`)', () => {
    expect(partykitProtocol('http:')).toBeUndefined();
  });
});
