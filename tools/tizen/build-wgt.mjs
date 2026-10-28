// Builds the Samsung Tizen TV package.
//   1. `pnpm build:tv` (Vite production build of apps/tv)
//   2. copies apps/tv/dist + apps/tv/tizen/config.xml + icon.png into dist-tizen/, strips `crossorigin` and injects
//      the webapis.js script tag into dist-tizen/index.html (and fails if it is missing)
//   3. always zips dist-tizen/ into dist-tizen/Saqqezy-Player-unsigned.wgt (pure JS, no Tizen CLI needed; config.xml at
//      the zip root). Apps2Samsung or Tizen Studio sign it for the target device.
//   4. if the Tizen CLI (`tizen`) is on PATH and TIZEN_PROFILE names a certificate profile, also signs and packages
//      dist-tizen/ into a signed .wgt; otherwise prints what to do next and exits 0.
// It prints the relay and companion addresses baked into the build. Without them the Vite build warns loudly;
// with REQUIRE_PROD_ENV=1 it fails (tools/build/prodEnv.mjs).
// Usage: pnpm build:tizen            (TIZEN_PROFILE=<profile name> pnpm build:tizen to sign)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakedValues, checkProdEnv, viteEnv } from '../build/prodEnv.mjs';
import { makeIconPng } from './make-icon.mjs';
import { zipDirectory } from './zip.mjs';

const UNSIGNED_WGT = 'Saqqezy-Player-unsigned.wgt';
/** A Tizen package id is exactly 10 letters or digits; the app id is `<package id>.<name>`. */
const PACKAGE_ID = /^[A-Za-z0-9]{10}$/;
const APP_ID = /^[A-Za-z0-9]{10}\.[A-Za-z0-9]+$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'apps', 'tv', 'dist');
const tizenDir = join(root, 'apps', 'tv', 'tizen');
const out = join(root, 'dist-tizen');
const isWindows = process.platform === 'win32';

// On Windows pnpm.cmd / tizen.bat need a shell, which re-splits the command line: quote every argument
// (cmd.exe style, embedded quotes doubled) so paths and profile names with spaces survive.
const winQuote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function run(cmd, args, opts = {}) {
  if (isWindows) {
    return spawnSync([cmd, ...args].map(winQuote).join(' '), { cwd: root, stdio: 'inherit', shell: true, ...opts });
  }
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
}

function fail(msg) {
  console.error(`\nbuild:tizen failed: ${msg}`);
  process.exit(1);
}

// 0. The addresses this package will talk to (the Vite build checks them again, and fails in strict mode).
const tvEnv = viteEnv(join(root, 'apps', 'tv'));
console.log('Baked into this build:');
for (const line of bakedValues('tv', tvEnv)) console.log(`  ${line}`);
try {
  checkProdEnv('tv', tvEnv, { warn: () => {} }); // strict mode stops here; the warning itself comes from the Vite build
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
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
let html = readFileSync(indexPath, 'utf8').replace(/\s+crossorigin(=("[^"]*"|'[^']*'))?/g, '');

// On a Samsung TV, `webapis` (AVPlay, product info) only exists when the page loads Samsung's script. It must be
// in the Tizen package only (the browser/dev index.html has no such file), and before the app's module script.
const WEBAPIS_TAG = '<script src="$WEBAPIS/webapis/webapis.js"></script>';
const MODULE_SCRIPT = /<script[ >][^>]*type=["']module["']/i;
const firstModule = MODULE_SCRIPT.exec(html);
if (!firstModule) fail('dist-tizen/index.html has no module script to put webapis.js before.');
html = html.slice(0, firstModule.index) + WEBAPIS_TAG + '\n    ' + html.slice(firstModule.index);
writeFileSync(indexPath, html);

const finalHtml = readFileSync(indexPath, 'utf8');
const tagAt = finalHtml.indexOf(WEBAPIS_TAG);
const moduleAt = finalHtml.search(MODULE_SCRIPT);
if (tagAt === -1 || moduleAt === -1 || tagAt > moduleAt) {
  fail('dist-tizen/index.html does not load webapis.js before the module script; AVPlay would not work on the TV.');
}

for (const f of ['index.html', 'config.xml', 'icon.png']) {
  if (!existsSync(join(out, f))) fail(`dist-tizen/${f} is missing.`);
}
const configXml = readFileSync(join(out, 'config.xml'), 'utf8');
const appId = /<tizen:application[^>]*\bid="([^"]+)"/.exec(configXml)?.[1] ?? '';
const packageId = /<tizen:application[^>]*\bpackage="([^"]+)"/.exec(configXml)?.[1] ?? '';
const idProblem = !PACKAGE_ID.test(packageId)
  ? `the package id "${packageId}" in apps/tv/tizen/config.xml must be exactly 10 letters or digits.`
  : !APP_ID.test(appId) || !appId.startsWith(`${packageId}.`)
    ? `the application id "${appId}" in apps/tv/tizen/config.xml must be "<package id>.<Name>", e.g. "${packageId}.IptvPlayer".`
    : '';
console.log(`\nAssembled ${out}.`);

// 3. Unsigned .wgt (a zip of the package folder, config.xml at the root). No Tizen CLI needed.
if (idProblem) fail(idProblem);
const unsignedPath = join(out, UNSIGNED_WGT);
const packed = zipDirectory(out, unsignedPath, (f) => f.toLowerCase().endsWith('.wgt'));
console.log(`Unsigned package: dist-tizen/${UNSIGNED_WGT} (${statSync(unsignedPath).size} bytes, ${packed.length} files).`);
console.log('Apps2Samsung or Tizen Studio signs it for your device: see docs/install-on-samsung.md.');

// 4. Sign and package when possible.
const hasCli = run('tizen', ['version'], { stdio: 'ignore' }).status === 0;
const profile = process.env.TIZEN_PROFILE?.trim();

if (!hasCli || !profile) {
  const lines = [
    '',
    'Next steps (only the unsigned .wgt was made; the Tizen CLI is optional):',
    !hasCli
      ? '  - The Tizen CLI ("tizen") was not found on PATH. Install Tizen Studio (or the CLI) with the Samsung TV'
        + ' extension and add its tools/ide/bin folder to PATH.'
      : '  - The Tizen CLI is installed.',
    !profile
      ? '  - Set TIZEN_PROFILE to the name of your Samsung certificate profile, e.g.'
        + (isWindows ? '\n      $env:TIZEN_PROFILE="MyTV"; pnpm build:tizen   (PowerShell)' : '\n      TIZEN_PROFILE=MyTV pnpm build:tizen')
      : `  - Certificate profile: ${profile}`,
    '  - Full guide: docs/install-on-samsung.md',
    '',
  ];
  console.log(lines.filter(Boolean).join('\n'));
  process.exit(0);
}

console.log(`> tizen package -t wgt -s ${profile} -- dist-tizen`);
// Keep the unsigned zip out of the folder being signed, then put it back.
const stash = join(root, 'dist-tizen-unsigned.tmp');
renameSync(unsignedPath, stash);
const pkg = run('tizen', ['package', '-t', 'wgt', '-s', profile, '--', out]);
renameSync(stash, unsignedPath);
if (pkg.status !== 0) fail('"tizen package" failed (see above). Check the certificate profile name.');
const wgt = readdirSync(out).find((f) => f.toLowerCase().endsWith('.wgt') && f !== UNSIGNED_WGT);
if (!wgt) fail('"tizen package" finished but no .wgt file was found in dist-tizen/.');
console.log(`\nSigned package: dist-tizen/${wgt}`);
console.log('Install it on the TV (after "sdb connect <TV-IP>"; find <device> with "sdb devices"):');
console.log(`  tizen install -n "${wgt}" -t <device> -- dist-tizen`);
