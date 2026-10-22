import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { crc32, zipBuffer } from '../zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Reads a zip through its central directory (independent of the writer's local headers). */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const dataAt = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(dataAt, dataAt + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

describe('zip writer', () => {
  it('round-trips stored and deflated files with correct CRCs', () => {
    const big = Buffer.from('abc'.repeat(1000));
    const tiny = Buffer.from('x');
    const out = unzip(zipBuffer([{ name: 'config.xml', data: tiny }, { name: 'a/b.txt', data: big }]));
    expect([...out.keys()]).toEqual(['config.xml', 'a/b.txt']);
    expect(out.get('a/b.txt')!.equals(big)).toBe(true);
    expect(out.get('config.xml')!.equals(tiny)).toBe(true);
  });
  it('matches the standard CRC-32 check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('config.xml identity', () => {
  const xml = readFileSync(join(root, 'apps', 'tv', 'tizen', 'config.xml'), 'utf8');
  it('has a valid 10-character package id and a matching app id', () => {
    const pkg = /<tizen:application[^>]*\bpackage="([^"]+)"/.exec(xml)?.[1];
    const id = /<tizen:application[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
    expect(pkg).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(id).toBe(`${pkg}.IptvPlayer`);
    expect(xml).toContain('required_version="6.0"');
  });
});

// Runs the whole build (vite included), so it is slow; the earlier tests cover the pieces.
describe('pnpm build:tizen', () => {
  it('writes an unsigned .wgt with config.xml at the root and the webapis-injected index.html', () => {
    execFileSync(process.execPath, [join(root, 'tools', 'tizen', 'build-wgt.mjs')], {
      cwd: root, stdio: 'pipe', env: { ...process.env, PATH: process.env.PATH, TIZEN_PROFILE: '' },
    });
    const wgt = join(root, 'dist-tizen', 'Saqqezy-Player-unsigned.wgt');
    expect(existsSync(wgt)).toBe(true);
    expect(statSync(wgt).size).toBeGreaterThan(1000);
    const files = unzip(readFileSync(wgt));
    for (const f of ['config.xml', 'index.html', 'icon.png']) expect(files.has(f)).toBe(true);
    expect(files.get('index.html')!.toString('utf8')).toContain('$WEBAPIS/webapis/webapis.js');
    expect(files.get('config.xml')!.toString('utf8')).toContain('IptvPlyr01.IptvPlayer');
    expect(files.get('icon.png')!.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([...files.keys()].some((n) => n.endsWith('.wgt'))).toBe(false);
  }, 180_000);
});
