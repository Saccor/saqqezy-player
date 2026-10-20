// `pnpm companion:deploy`: builds the companion page for the production relay and deploys it as the
// `saqqezy-companion` static-assets Worker (apps/companion/wrangler.jsonc). Extra arguments go to
// `wrangler deploy`, for example `pnpm companion:deploy --dry-run`.
//
// A Node script rather than an inline `VAR=value` so it works the same in PowerShell, cmd and Git Bash.
// REQUIRE_PROD_ENV=1 makes the build fail instead of baking in the dev relay if the URL ever goes missing.
import { spawnSync } from 'node:child_process';

const RELAY_URL = 'wss://iptv-relay-production.sacco-rezais.workers.dev';

const env = { ...process.env, VITE_RELAY_URL: RELAY_URL, REQUIRE_PROD_ENV: '1' };

function run(args) {
  console.log(`> pnpm ${args.join(' ')}`);
  // shell: pnpm is pnpm.cmd on Windows, which spawn cannot start directly.
  const r = spawnSync('pnpm', args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`Companion build with VITE_RELAY_URL=${RELAY_URL}`);
run(['--filter', '@iptv/companion', 'build']);
// wrangler has to run in apps/companion: it refuses to run at the pnpm workspace root.
run(['--filter', '@iptv/companion', 'run', 'deploy', ...process.argv.slice(2)]);
