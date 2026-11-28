// Build and publish a new Nextspace Android app.
//
//   npm run release:android                     bump the version (1.1 -> 1.2) and build
//   npm run release:android -- --version 2.0
//
// Afterwards downloads/nextspace-android.apk is the new build. Commit and push it: installed apps
// compare its SHA-256 with their own (/api/app/android-update) and offer the update by themselves.
//
// The APK is signed with client/android-tools/AndroidHome/debug.keystore, the key every published
// build so far has used. Android refuses an update signed with a different key, so this script stops
// before publishing if the new APK's certificate differs from the one it would replace.
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT, ROOT, bumpVersion, capture, done, flag, megabytes, run, sha256File, writeKeepingEol } from './release-lib.mjs';

const TOOLS = path.join(CLIENT, 'android-tools');
const ANDROID = path.join(CLIENT, 'android');
const GRADLE_FILE = path.join(ANDROID, 'app', 'build.gradle');
const BUILT_APK = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PUBLISHED_APK = path.join(ROOT, 'downloads', 'nextspace-android.apk');
const JAVA = path.join(TOOLS, 'Jdk21', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const gradleEnv = {
  JAVA_HOME: path.join(TOOLS, 'Jdk21'),
  GRADLE_USER_HOME: path.join(TOOLS, 'Gradle'),
  ANDROID_USER_HOME: path.join(TOOLS, 'AndroidHome'), // holds debug.keystore, the signing key
  GRADLE_OPTS: `-Duser.home=${path.join(TOOLS, 'AndroidHome')}`,
};

function apksignerJar() {
  const buildTools = path.join(TOOLS, 'Sdk', 'build-tools');
  const versions = fs.existsSync(buildTools) ? fs.readdirSync(buildTools).sort().reverse() : [];
  for (const version of versions) {
    const jar = path.join(buildTools, version, 'lib', 'apksigner.jar');
    if (fs.existsSync(jar)) return jar;
  }
  throw new Error('apksigner.jar not found under client/android-tools/Sdk/build-tools');
}

/** SHA-256 of the certificate an APK is signed with. */
export async function signingCertificate(apk) {
  const out = await capture(JAVA, ['-jar', apksignerJar(), 'verify', '--print-certs', apk]);
  const match = out.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i);
  if (!match) throw new Error(`Could not read the signing certificate of ${path.basename(apk)}`);
  return match[1].toLowerCase();
}

/**
 * The Android Gradle Plugin 8.x uses a Gradle internal API removed in Gradle 9.6, so a wrapper
 * upgraded past 9.5 fails with a long stack trace. Catch that before spending minutes on a build.
 */
function checkGradleVersion() {
  const wrapper = fs.readFileSync(path.join(ANDROID, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  const gradle = wrapper.match(/gradle-(\d+)\.(\d+)(?:\.\d+)?-(?:all|bin)\.zip/);
  const agp = fs.readFileSync(path.join(ANDROID, 'build.gradle'), 'utf8').match(/com\.android\.tools\.build:gradle:(\d+)\./);
  if (!gradle || !agp) return;
  const [major, minor] = [Number(gradle[1]), Number(gradle[2])];
  if (Number(agp[1]) < 9 && (major > 9 || (major === 9 && minor >= 6))) {
    throw new Error(`android/gradle/wrapper/gradle-wrapper.properties asks for Gradle ${gradle[1]}.${gradle[2]}, but the Android Gradle Plugin ${agp[1]}.x in android/build.gradle needs Gradle 9.5 or older. Set distributionUrl back to gradle-8.14.3-all.zip (the version used for every release so far).`);
  }
}

async function main() {
  for (const required of [JAVA, path.join(TOOLS, 'AndroidHome', 'debug.keystore')]) {
    if (!fs.existsSync(required)) throw new Error(`Missing ${path.relative(ROOT, required)}. See client/ANDROID_APP.md.`);
  }
  checkGradleVersion();
  const previousCert = fs.existsSync(PUBLISHED_APK) ? await signingCertificate(PUBLISHED_APK) : null;
  if (flag('check')) {
    console.log(`Toolchain OK. Published APK is signed with ${previousCert || '(no APK published yet)'}.`);
    return;
  }

  // 1. New version: versionCode must always increase or Android won't install it as an update.
  const gradle = fs.readFileSync(GRADLE_FILE, 'utf8');
  const code = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  const name = gradle.match(/versionName\s+"([^"]+)"/)?.[1];
  if (!code || !name) throw new Error('versionCode/versionName not found in android/app/build.gradle');
  const nextName = typeof flag('version') === 'string' ? flag('version') : bumpVersion(name);
  const nextCode = code + 1;
  console.log(`Nextspace Android ${name} (${code}) -> ${nextName} (${nextCode})`);
  writeKeepingEol(GRADLE_FILE, gradle, gradle
    .replace(/versionCode\s+\d+/, `versionCode ${nextCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${nextName}"`));

  try {
    // 2. Android SDK location (local.properties is ignored by Git).
    const localProps = path.join(ANDROID, 'local.properties');
    if (!fs.existsSync(localProps)) fs.writeFileSync(localProps, `sdk.dir=${path.join(TOOLS, 'Sdk').replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`);

    // 3. Web bundle into the native project, then the APK.
    await run('npm', ['run', 'build'], { cwd: CLIENT });
    await run('npx', ['cap', 'sync', 'android'], { cwd: CLIENT });
    if (fs.existsSync(BUILT_APK)) fs.rmSync(BUILT_APK);
    // Full path: Windows skips the current folder when NoDefaultCurrentDirectoryInExePath is set.
    await run(path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleDebug', '--no-daemon', '--no-parallel', '--max-workers=1'], { cwd: ANDROID, env: gradleEnv });
    if (!fs.existsSync(BUILT_APK)) throw new Error('Gradle finished but no APK was produced');

    // 4. Same signing key as the build people already have, or the update can't install.
    const newCert = await signingCertificate(BUILT_APK);
    if (previousCert && newCert !== previousCert) {
      throw new Error(`The new APK is signed with a different key (${newCert.slice(0, 16)}...) than the published one (${previousCert.slice(0, 16)}...). Installed apps could not update. Nothing was published.`);
    }
    // 5. Publish.
    fs.mkdirSync(path.dirname(PUBLISHED_APK), { recursive: true });
    try {
      fs.copyFileSync(BUILT_APK, PUBLISHED_APK);
    } catch (err) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        throw new Error(`Windows would not let this account replace ${path.relative(ROOT, PUBLISHED_APK)} (${err.code}). Either the folder is read-only for your user or another program has the file open. Fix the folder permissions (see client/ANDROID_APP.md) or run the terminal as Administrator, then run the release again.`);
      }
      throw err;
    }
  } catch (err) {
    writeKeepingEol(GRADLE_FILE, gradle, gradle); // put the version back: nothing was released
    throw err;
  }
  const size = fs.statSync(PUBLISHED_APK).size;
  done([
    `Nextspace Android ${nextName} (versionCode ${nextCode}) is ready.`,
    `  ${path.relative(ROOT, PUBLISHED_APK)}  ${megabytes(size)}`,
    `  SHA-256 ${sha256File(PUBLISHED_APK)}`,
    '',
    'Next: commit downloads/nextspace-android.apk and client/android/app/build.gradle, then push.',
    'Installed apps offer the update on their next check (every 30 minutes while open).',
  ]);
}

main().catch((err) => {
  console.error(`\nRelease failed: ${err.message}`);
  process.exit(1);
});
