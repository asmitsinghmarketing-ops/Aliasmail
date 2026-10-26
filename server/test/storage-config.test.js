import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const moduleUrl = new URL('../src/config.js', import.meta.url).href;
function check(extra) {
  const code = 'import config from ' + JSON.stringify(moduleUrl) + '; console.log(JSON.stringify({databaseConfigured:!!config.databaseUrl}));';
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', JWT_SECRET: 'test-only-stable-key', ALLOW_FILE_STORAGE: 'false', ...extra },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
test('production refuses ephemeral storage', () => {
  assert.throws(() => check({}), (error) => error.stderr.includes('Persistent storage is required'));
});
test('production refuses a generated encryption key', () => {
  assert.throws(() => check({ DATABASE_URL: 'mysql://user:password@example.test/mail', JWT_SECRET: '' }),
    (error) => error.stderr.includes('stable JWT_SECRET'));
});
test('database URLs are validated without printing credentials', () => {
  assert.throws(() => check({ DATABASE_URL: 'sqlite:secret-password' }),
    (error) => error.stderr.includes('DATABASE_URL must use') && !error.stderr.includes('secret-password'));
});
test('production accepts a stable database configuration', () => {
  assert.match(check({ DATABASE_URL: 'postgres://user:password@example.test/mail' }), /"databaseConfigured":true/);
});
test('an explicitly persistent disk is allowed', () => {
  assert.match(check({ ALLOW_FILE_STORAGE: 'true' }), /"databaseConfigured":false/);
});
