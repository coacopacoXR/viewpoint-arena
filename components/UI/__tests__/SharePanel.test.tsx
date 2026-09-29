import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import SharePanel from '../SharePanel';
import * as ConfigContext from '../../../lib/config/ConfigContext.tsx';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, ...rest }: { value: string; [k: string]: unknown }) => (
    <svg data-testid="qr-svg" data-value={value} {...rest} />
  ),
}));

const baseConfig: ConfigContext.ConnectorConfig = {
  config: {
    plm: { provider: 'mock' },
    capture: { provider: 'mock' },
    turn: { provider: 'cloudflare' },
    db: { provider: 'supabase' },
    identity: { mode: 'none', methods: [], allowGuests: false },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
    modelStorage: { provider: 'local' },
  },
  loading: false,
  error: null,
  available: true,
  publicUrl: undefined,
  plm: 'mock',
  capture: 'mock',
  turn: 'cloudflare',
  db: 'supabase',
  modelImport: 'genericGltf',
  notifications: [],
};

function renderPanel(overrides: Partial<ConfigContext.ConnectorConfig> = {}) {
  vi.spyOn(ConfigContext, 'useConnectorConfig').mockReturnValue({
    ...baseConfig,
    ...overrides,
  });
  return render(<SharePanel roomId="abcdef12-3456-7890-abcd-ef1234567890" onClose={() => {}} />);
}

describe('SharePanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://localhost' },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('uses publicUrl when present', () => {
    renderPanel({ publicUrl: 'https://192.168.1.50' });

    const qr = screen.getByTestId('qr-svg');
    expect(qr.getAttribute('data-value')).toBe(
      'https://192.168.1.50/room/abcdef12-3456-7890-abcd-ef1234567890',
    );
    expect(screen.queryByTestId('local-only-warning')).toBeNull();
  });

  it('falls back to window.location.origin when publicUrl is absent', () => {
    renderPanel({ publicUrl: undefined });

    const qr = screen.getByTestId('qr-svg');
    expect(qr.getAttribute('data-value')).toBe(
      'https://localhost/room/abcdef12-3456-7890-abcd-ef1234567890',
    );
  });

  it('falls back to window.location.origin while config is loading', () => {
    renderPanel({ loading: true, config: null, available: false, publicUrl: undefined });

    const qr = screen.getByTestId('qr-svg');
    expect(qr.getAttribute('data-value')).toContain('/room/');
  });

  it('renders the local-only warning when publicUrl host is localhost', () => {
    renderPanel({ publicUrl: 'https://localhost' });

    expect(screen.getByTestId('local-only-warning')).toBeTruthy();
    expect(screen.getByTestId('local-only-warning').textContent).toContain(
      'only opens on this computer',
    );
  });

  it('renders the local-only warning when publicUrl host is 127.0.0.1', () => {
    renderPanel({ publicUrl: 'https://127.0.0.1' });

    expect(screen.getByTestId('local-only-warning')).toBeTruthy();
  });

  it('does not render the local-only warning for a real host', () => {
    renderPanel({ publicUrl: 'https://192.168.1.50' });

    expect(screen.queryByTestId('local-only-warning')).toBeNull();
  });

  it('renders the local-only warning when falling back to localhost origin', () => {
    renderPanel({ publicUrl: undefined });

    expect(screen.getByTestId('local-only-warning')).toBeTruthy();
  });

  it('renders the mismatch note when origin differs from publicUrl', () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://localhost' },
      writable: true,
    });
    renderPanel({ publicUrl: 'https://192.168.1.50' });

    const note = screen.getByTestId('mismatch-warning');
    expect(note.textContent).toContain('viewing this at https://localhost');
    expect(note.textContent).toContain('https://192.168.1.50');
  });

  it('does not render the mismatch note when origin matches publicUrl', () => {
    Object.defineProperty(window, 'location', {
      value: { origin: 'https://192.168.1.50' },
      writable: true,
    });
    renderPanel({ publicUrl: 'https://192.168.1.50' });

    expect(screen.queryByTestId('mismatch-warning')).toBeNull();
  });

  it('does not render the mismatch note when publicUrl is absent', () => {
    renderPanel({ publicUrl: undefined });

    expect(screen.queryByTestId('mismatch-warning')).toBeNull();
  });

  it('shows the warning above the QR code', () => {
    renderPanel({ publicUrl: 'https://localhost' });

    const warning = screen.getByTestId('local-only-warning');
    const qr = screen.getByTestId('qr-svg');
    // compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING means qr comes
    // after warning in document order — i.e. warning is above the QR.
    expect(warning.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
