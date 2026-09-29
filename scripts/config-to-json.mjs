#!/usr/bin/env node
// scripts/config-to-json.mjs
//
// Reads viewpoint.config.ts from the current working directory, validates it
// with the master schema, and prints single-line JSON to stdout. The output is
// what an operator pastes into the VIEWPOINT_CONFIG environment variable on
// hosts that cannot carry a config file (Vercel, serverless, etc.).
//
// Nothing secret is printed: the config names env vars (`apiKeyEnv:
// 'OPENAI_API_KEY'`), it never holds their values.

import { tsImport } from 'tsx/esm/api';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const configFile = resolve(process.cwd(), 'viewpoint.config.ts');
if (!existsSync(configFile)) {
  console.error(
    `No viewpoint.config.ts in ${process.cwd()}.\n` +
      'Run this from the folder that holds your config (copy viewpoint.config.example.ts to start one).',
  );
  process.exit(1);
}

const mod = await tsImport(pathToFileURL(configFile).href, import.meta.url);

// The same validator loadConfig uses, resolved next to this script rather than
// the cwd, so the JSON pasted into VIEWPOINT_CONFIG is guaranteed to pass it.
const { validateConfig } = await tsImport(
  new URL('../lib/config/loadConfig.ts', import.meta.url).href,
  import.meta.url,
);

try {
  validateConfig(mod.default);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

process.stdout.write(JSON.stringify(mod.default) + '\n');
