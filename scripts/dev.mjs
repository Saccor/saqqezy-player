// Runs the fake provider and the TV app's Vite dev server together, prefixing each line of output.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const isWin = process.platform === 'win32';
// --stable: the TV dev server never reloads the page by itself (watching sessions); F5 loads code changes.
const stable = process.argv.includes('--stable');
const procs = [
  // PORT is pinned: launchers often export PORT for the app itself, and the fake provider must stay on 8899.
  { name: 'fake-xtream', color: 35, args: ['fake-xtream'], env: { PORT: '8899' } },
  { name: 'tv', color: 36, args: ['--filter', '@iptv/tv', 'dev'], env: stable ? { IPTV_DEV_STABLE: '1' } : {} },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    // On Windows the child is a shell; kill the whole tree so no server keeps its port.
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const p of procs) {
  const child = spawn('pnpm', p.args, { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...p.env } });
  children.push(child);
  const prefix = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => process.stdout.write(`${prefix}${line}\n`));
  }
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code ?? 'null'}\n`);
    shutdown(code ?? 1);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
