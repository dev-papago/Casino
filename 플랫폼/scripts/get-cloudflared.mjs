// Downloads the pinned cloudflared for Windows into vendor/ and checks its SHA-256.
// The online ledger exe ships this file; it is not in git (55 MB). Run again after changing the version.
// Pin a release that has been out for at least two weeks, and change SHA256 with it (from the release notes).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const VERSION = '2026.10.0';
const SHA256 = '86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c';
const URL = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;

const dir = resolve(import.meta.dirname, '..', 'vendor');
const file = join(dir, 'cloudflared.exe');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(file) && sha(readFileSync(file)) === SHA256) {
  console.log(`vendor/cloudflared.exe ${VERSION} already present`);
} else {
  console.log(`downloading cloudflared ${VERSION} …`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== SHA256) throw new Error(`checksum mismatch: expected ${SHA256}, got ${got}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, buf);
  renameSync(`${file}.part`, file);
  console.log(`vendor/cloudflared.exe ${VERSION} (${(buf.length / 1e6).toFixed(1)} MB, sha256 ok)`);
}
