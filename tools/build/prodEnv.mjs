// Production build environment check, shared by the TV and companion Vite builds and tools/tizen/build-wgt.mjs.
//
// Without VITE_RELAY_URL / VITE_COMPANION_ORIGIN a production build silently bakes in the local dev defaults
// (ws://127.0.0.1:8787, http://localhost:5174), and pairing cannot work on a real TV or phone. A production build
// therefore warns loudly about every missing value; with REQUIRE_PROD_ENV=1 it fails instead.
// Plain JavaScript (with prodEnv.d.mts) so the Node build script can import it without a TypeScript loader.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The variables each app bakes in, with the dev default it falls back to. */
export const PROD_ENV = {
  tv: { VITE_RELAY_URL: 'ws://127.0.0.1:8787', VITE_COMPANION_ORIGIN: 'http://localhost:5174' },
  companion: { VITE_RELAY_URL: 'ws://127.0.0.1:8787' },
};

/** True when `REQUIRE_PROD_ENV` asks for a failing build instead of a warning. */
export function strictProdEnv(processEnv = process.env) {
  const v = (processEnv.REQUIRE_PROD_ENV ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** The names of `app`'s variables that are unset or empty in `env` (the apps treat empty as unset). */
export function missingProdEnv(app, env) {
  return Object.keys(PROD_ENV[app]).filter((name) => !String(env[name] ?? '').trim());
}

/** The values a build bakes in: the configured ones, or the dev default marked as such. */
export function bakedValues(app, env) {
  return Object.entries(PROD_ENV[app]).map(([name, fallback]) => {
    const v = String(env[name] ?? '').trim();
    return v ? `${name}=${v}` : `${name}=${fallback}  (unset: dev default)`;
  });
}

/** The loud warning (or the strict-mode error) for `missing`; undefined when nothing is missing. */
export function prodEnvMessage(app, missing, strict) {
  if (missing.length === 0) return undefined;
  const fallbacks = missing.map((n) => `  ${n} is not set; this build will use the dev default ${PROD_ENV[app][n]}.`);
  const bar = '!'.repeat(78);
  return [
    bar,
    `${strict ? 'ERROR' : 'WARNING'}: production build of the ${app} app without its deployment settings.`,
    ...fallbacks,
    '  Pairing with the phone companion will not work outside this computer.',
    '  Set them for the build (see docs/deploy-companion.md).',
    strict ? '  REQUIRE_PROD_ENV is set, so the build stops here.' : '  Set REQUIRE_PROD_ENV=1 to make this an error.',
    bar,
  ].join('\n');
}

/**
 * Checks `env` for a production build of `app`: warns loudly through `warn`, or throws in strict mode.
 * Returns the missing names.
 */
export function checkProdEnv(app, env, opts = {}) {
  const strict = opts.strict ?? strictProdEnv();
  const missing = missingProdEnv(app, env);
  const message = prodEnvMessage(app, missing, strict);
  if (message) {
    if (strict) throw new Error(message);
    (opts.warn ?? console.warn)(message);
  }
  return missing;
}

/** Vite plugin: runs `checkProdEnv` for production builds (never for the dev server or a development-mode build). */
export function prodEnvCheck(app) {
  return {
    name: 'prod-env-check',
    apply: 'build',
    configResolved(config) {
      if (!config.isProduction) return;
      // `config.env` already holds the .env files and the process environment's VITE_ variables (Vite's loadEnv).
      checkProdEnv(app, config.env);
    },
  };
}

function pickVite(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith('VITE_') && v !== undefined) out[k] = v;
  return out;
}

/**
 * The VITE_ variables a Vite build in `dir` sees for `mode`: `.env`, `.env.local`, `.env.<mode>` and
 * `.env.<mode>.local` (later files win), then the process environment, which wins over every file.
 * Only simple `KEY=value` lines are read (enough to report what a build bakes in).
 */
export function viteEnv(dir, mode = 'production', processEnv = process.env) {
  const out = {};
  for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return { ...out, ...pickVite(processEnv) };
}
