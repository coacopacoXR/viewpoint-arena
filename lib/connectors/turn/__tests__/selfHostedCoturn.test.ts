// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import {
  COTURN_CREDENTIAL_TTL_SECONDS,
  SelfHostedCoturnAdapter,
  stunReachable,
  turnRestCredential,
} from '../selfHostedCoturn.ts';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function adapter(env: Record<string, string | undefined> = { COTURN_SECRET: 's3cret' }) {
  return new SelfHostedCoturnAdapter({
    host: 'turn.example.org',
    port: 3478,
    sharedSecretEnv: 'COTURN_SECRET',
    env,
    now: () => NOW,
  });
}

describe('turnRestCredential', () => {
  it('equals base64(HMAC-SHA1(secret, username)) as coturn computes it', async () => {
    // Checked against Node's own HMAC, an independent implementation.
    const username = '1790078400:viewpoint';
    const expected = createHmac('sha1', 's3cret').update(username).digest('base64');
    await expect(turnRestCredential('s3cret', username)).resolves.toBe(expected);
  });
});

describe('SelfHostedCoturnAdapter.getIceServers', () => {
  it('returns STUN plus UDP/TCP TURN with a time-limited REST credential', async () => {
    const servers = await adapter().getIceServers();
    const expiry = Math.floor(NOW / 1000) + COTURN_CREDENTIAL_TTL_SECONDS;
    expect(servers[0]).toEqual({ urls: 'stun:turn.example.org:3478' });
    expect(servers[1].urls).toEqual([
      'turn:turn.example.org:3478?transport=udp',
      'turn:turn.example.org:3478?transport=tcp',
    ]);
    expect(servers[1].username).toBe(`${expiry}:viewpoint`);
    expect(servers[1].credential).toBe(
      createHmac('sha1', 's3cret').update(`${expiry}:viewpoint`).digest('base64'),
    );
  });

  it('never puts the shared secret itself in what the browser receives', async () => {
    const body = JSON.stringify(await adapter().getIceServers());
    expect(body).not.toContain('s3cret');
    expect(body).not.toContain('COTURN_SECRET');
  });

  it('refuses to mint anything without the secret', async () => {
    await expect(adapter({}).getIceServers()).rejects.toThrow(/COTURN_SECRET must be set/);
  });
});

describe('stunReachable', () => {
  let server: Socket | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  function listen(answer: boolean): Promise<number> {
    server = createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      if (!answer) return;
      // Binding Success Response echoing the magic cookie and transaction id.
      const res = Buffer.alloc(20);
      res.writeUInt16BE(0x0101, 0);
      msg.copy(res, 4, 4, 20);
      server?.send(res, rinfo.port, rinfo.address);
    });
    return new Promise((resolve) =>
      server!.bind(0, '127.0.0.1', () => resolve((server!.address() as AddressInfo).port)),
    );
  }

  it('is true when a STUN server answers the binding request', async () => {
    const port = await listen(true);
    await expect(stunReachable('127.0.0.1', port)).resolves.toBe(true);
  });

  it('is false, within the timeout, when nothing answers', async () => {
    const port = await listen(false);
    const started = Date.now();
    await expect(stunReachable('127.0.0.1', port)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('SelfHostedCoturnAdapter probeHost', () => {
  it('health probe uses probeHost when set', async () => {
    const probe = vi.fn(async () => true);
    const adapter = new SelfHostedCoturnAdapter({
      host: 'turn.example.org',
      port: 3478,
      sharedSecretEnv: 'S',
      env: { S: 'x' },
      probeHost: 'coturn',
      probe,
    });
    await adapter.healthCheck();
    expect(probe).toHaveBeenCalledWith('coturn', 3478);
  });

  it('health probe falls back to host when probeHost is not set', async () => {
    const probe = vi.fn(async () => true);
    const adapter = new SelfHostedCoturnAdapter({
      host: 'turn.example.org',
      port: 3478,
      sharedSecretEnv: 'S',
      env: { S: 'x' },
      probe,
    });
    await adapter.healthCheck();
    expect(probe).toHaveBeenCalledWith('turn.example.org', 3478);
  });

  it('ICE URLs always use host, never probeHost', async () => {
    const servers = await new SelfHostedCoturnAdapter({
      host: 'turn.example.org',
      port: 3478,
      sharedSecretEnv: 'S',
      env: { S: 'x' },
      probeHost: 'coturn',
      now: () => NOW,
    }).getIceServers();
    const allUrls = servers.flatMap((s) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    );
    for (const url of allUrls) {
      expect(url).toContain('turn.example.org');
      expect(url).not.toContain('coturn');
    }
  });
});
