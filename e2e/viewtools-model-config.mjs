#!/usr/bin/env node
// e2e/viewtools-model-config.mjs
//
// Prints the `VIEWPOINT_CONFIG` that e2e/viewToolsCut.spec.ts's import needs, and makes the
// directory the model bytes land in.
//
//     VIEWPOINT_CONFIG=$(node e2e/viewtools-model-config.mjs) npx vite --port 5199 --strictPort
//
// Why a script and not a line in the spec's header: the config is a whole JSON document
// because lib/config/configSchema.ts requires every block, and a header comment holding one
// is a header comment nobody can copy into a shell without breaking it. This is the same
// document scripts/perf/serve.mjs builds for the benchmark — every block set to the variant
// that needs nothing from the machine — so an import behaves the same way under both.
//
// The db block has no 'none' provider, so it names env vars and the caller fills them with
// dummies. That is safe because lib/supabase.ts reads the Supabase URL Vite inlined at build
// time, and with no VITE_SUPABASE_URL in the environment `supabaseConfigured` is false in the
// browser whatever this says, so pages/RoomPage.tsx takes its no-database path — which is the
// path a `partykit dev` room is on anyway. The names avoid the VITE_ prefix so
// scripts/check-public-env.mjs has nothing to say about them.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Under the already-gitignored fixtures directory, beside the model store the benchmark uses:
// a scratch place for bytes that must not leave the machine and must not be committed.
const STORE_DIR = join(REPO_ROOT, 'perf', 'fixtures', 'api-models');
mkdirSync(STORE_DIR, { recursive: true });

process.stdout.write(
  `${JSON.stringify({
    plm: { provider: 'none' },
    capture: { provider: 'mock' },
    turn: {
      provider: 'selfHostedCoturn',
      host: 'localhost',
      port: 3478,
      sharedSecretEnv: 'VP_E2E_TURN_SECRET',
    },
    db: { provider: 'supabase', urlEnv: 'VP_E2E_DB_URL', anonKeyEnv: 'VP_E2E_DB_ANON_KEY' },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
    modelStorage: { provider: 'local', dir: STORE_DIR },
  })}\n`,
);
