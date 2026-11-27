// Build and publish a new Nextspace Windows desktop app.
//
//   npm run release:desktop                     bump the version (1.0.0 -> 1.0.1) and build
//   npm run release:desktop -- --version 1.1.0
//
// Writes client/desktop/Nextspace-Desktop-Setup.exe and client/desktop/latest.json (version and
// SHA-256). Commit both and push: desktop apps from 1.1 on check /api/app/desktop-update, download
// the installer in the background, verify it and offer "Restart and update". Older 1.0.0 installs
// are shown a one-time download notice by the website instead.
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT, ROOT, bumpVersion, done, flag, megabytes, run, sha256File, writeKeepingEol } from './release-lib.mjs';

const DESKTOP = path.join(CLIENT, 'desktop');
const PACKAGE = path.join(DESKTOP, 'package.json');
const STABLE_NAME = 'Nextspace-Desktop-Setup.exe';
const MANIFEST = path.join(DESKTOP, 'latest.json');

async function main() {
  if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
  const original = fs.readFileSync(PACKAGE, 'utf8');
  const pkg = JSON.parse(original);
  const next = typeof flag('version') === 'string' ? flag('version') : bumpVersion(pkg.version);
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`Use a version like 1.2.0 (got "${next}")`);
  console.log(`Nextspace Desktop ${pkg.version} -> ${next}`);
  writeKeepingEol(PACKAGE, original, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`);

  let built;
  try {
    if (!fs.existsSync(path.join(DESKTOP, 'node_modules', 'electron-builder'))) await run('npm', ['ci'], { cwd: DESKTOP });
    await run('npm', ['run', 'dist:win'], { cwd: DESKTOP });
    built = path.join(DESKTOP, 'dist', `Nextspace-Desktop-${next}-Setup.exe`);
    if (!fs.existsSync(built)) throw new Error(`electron-builder finished but ${path.relative(ROOT, built)} is missing`);
  } catch (err) {
    writeKeepingEol(PACKAGE, original, original); // put the version back: nothing was released
    throw err;
  }

  // One stable installer name in the repo (tracked with Git LFS), described by latest.json.
  for (const old of fs.readdirSync(DESKTOP).filter((f) => /^Nextspace-Desktop-.*Setup\.exe$/i.test(f) && f !== STABLE_NAME)) {
    fs.rmSync(path.join(DESKTOP, old));
    console.log(`Removed the old installer ${old}`);
  }
  const target = path.join(DESKTOP, STABLE_NAME);
  fs.copyFileSync(built, target);
  const size = fs.statSync(target).size;
  const sha256 = sha256File(target);
  fs.writeFileSync(MANIFEST, `${JSON.stringify({ version: next, file: STABLE_NAME, sha256, size, releasedAt: new Date().toISOString() }, null, 2)}\n`);

  done([
    `Nextspace Desktop ${next} is ready.`,
    `  ${path.relative(ROOT, target)}  ${megabytes(size)}`,
    `  SHA-256 ${sha256}`,
    '',
    'Next: commit client/desktop (the installer, latest.json, package.json) and push.',
    'Desktop apps from 1.1 update themselves; 1.0.0 installs see a download notice once.',
  ]);
}

main().catch((err) => {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
});
