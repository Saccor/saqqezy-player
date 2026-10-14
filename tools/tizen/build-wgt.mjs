// Builds the Samsung Tizen TV package.
//   1. `pnpm build:tv` (Vite production build of apps/tv)
//   2. copies apps/tv/dist + apps/tv/tizen/config.xml + icon.png into dist-tizen/
//   3. if the Tizen CLI (`tizen`) is on PATH and TIZEN_PROFILE names a certificate profile, signs and packages
//      dist-tizen/ into a .wgt; otherwise prints what to do next and exits 0 (dist-tizen/ is left unsigned).
// Usage: pnpm build:tizen            (TIZEN_PROFILE=<profile name> pnpm build:tizen to sign)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIconPng } from './make-icon.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'apps', 'tv', 'dist');
const tizenDir = join(root, 'apps', 'tv', 'tizen');
const out = join(root, 'dist-tizen');
const isWindows = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  // shell on Windows so pnpm.cmd / tizen.bat resolve; arguments here never contain user secrets.
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWindows, ...opts });
}

function fail(msg) {
  console.error(`\nbuild:tizen failed: ${msg}`);
  process.exit(1);
}

// 1. Production build.
console.log('> pnpm build:tv');
const build = run('pnpm', ['build:tv']);
if (build.status !== 0) fail('the TV app build failed (see above).');
if (!existsSync(join(dist, 'index.html'))) fail('apps/tv/dist/index.html is missing after the build.');

// 2. Assemble dist-tizen/.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true });
cpSync(join(tizenDir, 'config.xml'), join(out, 'config.xml'));
const icon = join(tizenDir, 'icon.png');
if (existsSync(icon)) cpSync(icon, join(out, 'icon.png'));
else writeFileSync(join(out, 'icon.png'), makeIconPng());

// The widget is loaded from the package's file URL. A `crossorigin` attribute on the module script makes
// Chromium fetch it in CORS mode, which a file URL cannot satisfy on some engines: drop it.
const indexPath = join(out, 'index.html');
const html = readFileSync(indexPath, 'utf8');
writeFileSync(indexPath, html.replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, ''));

for (const f of ['index.html', 'config.xml', 'icon.png']) {
  if (!existsSync(join(out, f))) fail(`dist-tizen/${f} is missing.`);
}
const appId = /<tizen:application[^>]*\bid="([^"]+)"/.exec(readFileSync(join(out, 'config.xml'), 'utf8'))?.[1] ?? '';
console.log(`\nAssembled ${out} (unsigned).`);

// 3. Sign and package when possible.
const hasCli = spawnSync('tizen', ['version'], { stdio: 'ignore', shell: isWindows }).status === 0;
const profile = process.env.TIZEN_PROFILE?.trim();

if (!hasCli || !profile) {
  const lines = [
    '',
    'Next steps (no signed .wgt was made):',
    !hasCli
      ? '  - The Tizen CLI ("tizen") was not found on PATH. Install Tizen Studio (or the CLI) with the Samsung TV'
        + ' extension and add its tools/ide/bin folder to PATH.'
      : '  - The Tizen CLI is installed.',
    !profile
      ? '  - Set TIZEN_PROFILE to the name of your Samsung certificate profile, e.g.'
        + (isWindows ? '\n      $env:TIZEN_PROFILE="MyTV"; pnpm build:tizen   (PowerShell)' : '\n      TIZEN_PROFILE=MyTV pnpm build:tizen')
      : `  - Certificate profile: ${profile}`,
    appId.startsWith('XXXXXXXXXX')
      ? '  - Replace the placeholder package ID "XXXXXXXXXX" in apps/tv/tizen/config.xml first.'
      : '',
    '  - Full guide: docs/install-on-samsung.md',
    '',
  ];
  console.log(lines.filter(Boolean).join('\n'));
  process.exit(0);
}

if (appId.startsWith('XXXXXXXXXX')) {
  fail('apps/tv/tizen/config.xml still has the placeholder package ID "XXXXXXXXXX". Replace it first.');
}

console.log(`> tizen package -t wgt -s ${profile} -- dist-tizen`);
const pkg = run('tizen', ['package', '-t', 'wgt', '-s', profile, '--', out]);
if (pkg.status !== 0) fail('"tizen package" failed (see above). Check the certificate profile name.');
const wgt = readdirSync(out).find((f) => f.toLowerCase().endsWith('.wgt'));
if (!wgt) fail('"tizen package" finished but no .wgt file was found in dist-tizen/.');
console.log(`\nSigned package: dist-tizen/${wgt}`);
console.log('Install it on the TV (after "sdb connect <TV-IP>"; find <device> with "sdb devices"):');
console.log(`  tizen install -n "${wgt}" -t <device> -- dist-tizen`);
