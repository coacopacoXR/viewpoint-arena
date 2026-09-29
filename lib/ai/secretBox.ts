// At-rest encryption for the secrets in app_settings (plan 14, batch BF).
//
// An API key pasted into the admin console's AI section is stored in the
// database, not in a container's environment, so an organisation can change
// which AI does a job without a redeploy. That makes the database a holder of
// credentials, and a database is the thing an installation backs up, replicates
// and hands to a managed-service provider. So the value that lands in
// app_settings.secret is ciphertext.
//
// The key is DERIVED FROM JWT_SECRET rather than being a variable of its own:
//
//   * install.sh already generates JWT_SECRET on every self-hosted install and
//     preserves it across re-runs, so there is no new secret for an operator to
//     lose, and no install path that can forget to set one;
//   * the plan's SETTINGS_ENCRYPTION_KEY is honoured in spirit — one key, held
//     server-side only — without adding a second variable that a deployment can
//     set to a guessable value or leave empty. An empty derived key is
//     impossible: with no JWT_SECRET there is no encryption and no decryption,
//     and both refuse (see requireSecret below);
//   * rotating JWT_SECRET rotates this too, which is the behaviour an operator
//     expects from the one secret they were told to protect. The cost is that a
//     rotation invalidates every stored key, and the failure is loud rather than
//     silent: decryptSecret throws, the admin screen reports "key set" no
//     longer, and the job falls back to the configured default.
//
// HKDF-SHA256 separates this use from the JWT signing use of the same input
// material: the derived key is not JWT_SECRET, and a leaked derived key says
// nothing about token signatures (or the reverse).
//
// SERVER ONLY. This file must never end up in the browser bundle — it holds the
// ability to read every stored credential. The runtime guard below throws on
// import in a non-Node environment, and the marker string is what a build test
// greps dist/ for to prove the module was tree-shaken out.

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

if (typeof process === 'undefined' || !process.versions.node) {
  throw new Error(
    'secretBox.ts is server-only. It derives an encryption key from JWT_SECRET ' +
      'and must never be imported by client code.',
  );
}

/** Greppable marker: if this string appears in dist/, the module leaked. */
export const _SECRET_BOX_MARKER = '__SECRET_BOX_SERVER_ONLY__';

/** The HKDF info string. Versioned, so a future scheme derives a different key. */
export const SECRET_BOX_INFO = 'viewpoint-app-settings-v1';

/** Prefix of the stored form. Bumped if the cipher or the layout ever changes. */
export const SECRET_BOX_VERSION = 'v1';

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** HKDF's salt may be empty; the info string is what separates this use. */
const NO_SALT = Buffer.alloc(0);

/**
 * Any failure to seal or open a secret.
 *
 * The message never quotes its input: for `decryptSecret` the input is
 * ciphertext from a database row, and for `encryptSecret` it is a live API key.
 * An error that carried either would end up in a server log, and the whole
 * point of this module is that neither belongs there in the clear.
 */
export class SecretBoxError extends Error {
  constructor(reason: 'no_secret_configured' | 'malformed' | 'unsealed') {
    super(`secretBox: ${reason}`);
    this.name = 'SecretBoxError';
    this.reason = reason;
  }

  /** A stable, content-free classification, safe to branch on and to log. */
  readonly reason: 'no_secret_configured' | 'malformed' | 'unsealed';
}

function deriveKey(secret: string): Buffer {
  // hkdfSync returns an ArrayBuffer; Buffer.from copies it, so the key material
  // is ours and the underlying buffer cannot be transferred out from under us.
  return Buffer.from(hkdfSync('sha256', secret, NO_SALT, SECRET_BOX_INFO, KEY_BYTES));
}

function requireSecret(secret: string | undefined): string {
  const value = secret ?? process.env.JWT_SECRET ?? '';
  if (value.trim() === '') {
    // Fail closed. Deriving from an empty string would produce a key that is
    // the same on every unconfigured install — i.e. a public key — and would
    // look like working encryption right up to the moment the database leaked.
    throw new SecretBoxError('no_secret_configured');
  }
  return value;
}

/**
 * Seal a plaintext secret into the stored form `v1:<iv>:<tag>:<ct>`.
 *
 * All three parts are base64url with no padding, so the stored value is safe in
 * a text column, in a JSON body from PostgREST and in a log line without
 * needing escaping — and reading one tells you nothing, which is the point.
 *
 * A fresh random IV per call: GCM's security rests on never reusing an
 * (key, IV) pair, and a deterministic IV derived from the plaintext would make
 * two rows holding the same key produce the same ciphertext, which is a
 * comparison an attacker gets for free.
 */
export function encryptSecret(plaintext: string, secret?: string): string {
  const key = deriveKey(requireSecret(secret));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_BOX_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Open a stored secret, or throw SecretBoxError.
 *
 * FAILS CLOSED, in three separate ways, and each one matters:
 *   * a different JWT_SECRET derives a different key, and GCM's authentication
 *     tag then fails to verify — so a deployment restored from a backup taken
 *     under another secret reports `unsealed` instead of returning garbage;
 *   * a tampered ciphertext, IV or tag fails the same verification. GCM is
 *     authenticated encryption, so there is no "decrypt then notice it looks
 *     wrong": a modified row cannot produce a plaintext at all;
 *   * anything that is not the four-part `v1:` form is `malformed` before any
 *     crypto is attempted, which is what an operator sees after a hand edit.
 *
 * Never returns partial output and never echoes its input.
 */
export function decryptSecret(stored: string, secret?: string): string {
  const key = deriveKey(requireSecret(secret));

  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== SECRET_BOX_VERSION) {
    throw new SecretBoxError('malformed');
  }
  const [, ivPart, tagPart, ctPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ctPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('malformed');
  }

  const decipher = createDecipheriv(CIPHER, key, iv);
  // setAuthTag before final(): the tag is what makes a wrong key or a modified
  // row indistinguishable from "no plaintext", rather than yielding noise.
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('unsealed');
  }
}

/** True when a string is this module's stored form, without opening it. */
export function isSealedSecret(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === SECRET_BOX_VERSION;
}

/**
 * The tail of a secret, for the admin screen's "Key set · ends in …7f2a".
 *
 * Four characters is what a person needs to recognise which of their two keys
 * is configured here; it is not enough to narrow a search, and every vendor's
 * own dashboard shows the same tail, so this discloses nothing the operator
 * could not already see. Returns '' for a secret shorter than the tail rather
 * than returning the whole thing.
 */
export function secretTail(plaintext: string): string {
  const trimmed = plaintext.trim();
  return trimmed.length <= 4 ? '' : trimmed.slice(-4);
}
