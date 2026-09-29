import { configSchema, type ViewpointConfig } from './schema.ts';
import { ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (typeof process === 'undefined' || !process.versions.node) {
  throw new Error(
    'loadConfig.ts is server-only. Import lib/config/publicConfig.ts in client code instead.',
  );
}

export function validateConfig(config: unknown): ViewpointConfig {
  try {
    return configSchema.parse(config);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid viewpoint config:\n${issues}`);
    }
    throw err;
  }
}

type EnvField = { path: string; envName: string };

function extractEnvFields(obj: unknown, path: string[] = []): EnvField[] {
  if (obj === null || typeof obj !== 'object') return [];
  const fields: EnvField[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const currentPath = [...path, key].join('.');
    if (key.endsWith('Env') && typeof value === 'string') {
      fields.push({ path: currentPath, envName: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        fields.push(...extractEnvFields(item, [...path, key, String(i)]));
      });
    } else if (typeof value === 'object' && value !== null) {
      fields.push(...extractEnvFields(value, [...path, key]));
    }
  }
  return fields;
}

export function checkEnvVars(
  config: ViewpointConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const envFields = extractEnvFields(config);
  const missing: string[] = [];
  for (const { path, envName } of envFields) {
    const value = env[envName];
    if (value === undefined || value === '') {
      missing.push(`${path} '${envName}'`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((m) => `  - ${m} is not set`).join('\n')}`,
    );
  }
}

/**
 * viewpoint.config.ts at the deployment root, as an absolute file URL.
 *
 * Absolute on purpose. The old default was the bare './viewpoint.config.ts',
 * and a relative specifier in a dynamic import resolves against THIS module, so
 * it looked in lib/config/ — where the file never is. Every caller relying on
 * the default (public-config, turn-credentials, capture/extract) therefore
 * failed to load the config and silently fell back to defaults. The config sits
 * next to package.json, which is process.cwd() under `vercel dev`, the Vercel
 * runtime and the self-hosted app container alike. Resolved per call, not at
 * import time, so it follows the cwd the caller actually runs in.
 */
export function defaultConfigPath(): string {
  return pathToFileURL(resolve(process.cwd(), 'viewpoint.config.ts')).href;
}

let envOverrideWarned = false;

export function resolveConfigSource(): 'env:VIEWPOINT_CONFIG' | 'file:viewpoint.config.ts' {
  const raw = process.env.VIEWPOINT_CONFIG;
  if (raw && raw.trim()) return 'env:VIEWPOINT_CONFIG';
  return 'file:viewpoint.config.ts';
}

export async function loadConfig(
  configPath?: string,
): Promise<ViewpointConfig> {
  const envJson = process.env.VIEWPOINT_CONFIG;

  if (configPath === undefined && envJson && envJson.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envJson);
    } catch {
      // Deliberately not the parser's message: V8 quotes the start of the
      // input in it ("Unexpected token 'S', "{"plm": SECRET"..."), and the
      // value must not reach logs or error responses.
      throw new Error(
        'Invalid VIEWPOINT_CONFIG: not valid JSON. Regenerate it with `npm run config:json`.',
      );
    }
    const config = validateConfig(parsed);
    checkEnvVars(config);

    if (!envOverrideWarned) {
      const defaultPath = resolve(process.cwd(), 'viewpoint.config.ts');
      if (existsSync(defaultPath)) {
        console.warn(
          'VIEWPOINT_CONFIG is set and viewpoint.config.ts exists; using the environment variable',
        );
        envOverrideWarned = true;
      }
    }

    return config;
  }

  const resolvedPath = configPath ?? defaultConfigPath();
  let module: { default?: unknown };
  try {
    module = await import(resolvedPath);
  } catch (err) {
    throw new Error(
      `Failed to load config from ${resolvedPath}: ${(err as Error).message}`,
    );
  }
  if (!module.default) {
    throw new Error(`Config at ${resolvedPath} must have a default export`);
  }
  const config = validateConfig(module.default);
  checkEnvVars(config);
  return config;
}
