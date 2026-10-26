// Crashes are logged, and tests never write to the real log folder. A crash is checked for real: a separate process
// that throws (or leaves a rejected promise unhandled) must leave a server.crashed line in its log file before it
// exits, and must still exit with an error (logging changes nothing about the crash itself).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
let dir = '';
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'support-crash-'));
});
after(() => rm(dir, { recursive: true, force: true }));

// Runs a tiny program that installs the crash logger and then fails the given way; returns its exit code
async function crash(how: string) {
  const code = `
    (async () => {
      const { installCrashLogger } = await import('./src/services/logging.ts');
      installCrashLogger();
      ${how}
    })();
  `;
  try {
    await promisify(execFile)('npx', ['tsx', '--eval', code], { cwd: serverDir, env: { ...process.env, LOG_DIR: dir, NODE_TEST_CONTEXT: '' } });
    return 0;
  } catch (err: any) {
    return err.code as number;
  }
}

async function lines() {
  const files = (await import('node:fs')).readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f));
  const all = await Promise.all(files.map((f) => readFile(path.join(dir, f), 'utf8')));
  return all.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('a crash leaves its reason in the log file', () => {
  test('an uncaught error: logged with its message and stack, and the process still exits with an error', async () => {
    const exit = await crash(`setTimeout(() => { throw Object.assign(new Error('boom: database pool exhausted'), { code: 'POOL_TIMEOUT' }); }, 10);`);
    assert.notEqual(exit, 0, 'the crash still stops the process');
    const entry = (await lines()).find((l) => l.event === 'server.crashed' && /boom/.test(l.message));
    assert.ok(entry, 'server.crashed written before the process exited');
    assert.deepEqual([entry.level, entry.outcome, entry.previousStatus, entry.newStatus, entry.errorCode], ['ERROR', 'crashed', 'running', 'stopped', 'POOL_TIMEOUT']);
    assert.equal(entry.errorDetails, 'boom: database pool exhausted');
    assert.equal(entry.data.origin, 'uncaughtException');
    assert.match(entry.data.stack, /boom: database pool exhausted/);
    assert.match(entry.reason, /reached the top of the process uncaught/);
  });
  test('an unhandled rejected promise: logged as such', async () => {
    const exit = await crash(`setTimeout(() => { Promise.reject(new Error('nobody handled this rejection')); }, 10); setTimeout(() => {}, 1000);`);
    assert.notEqual(exit, 0);
    const entry = (await lines()).find((l) => l.event === 'server.crashed' && /nobody handled this rejection/.test(l.message));
    assert.ok(entry);
    assert.equal(entry.data.origin, 'unhandledRejection');
    assert.match(entry.reason, /rejected promise reached the top of the process unhandled/);
  });
});

test('under the test runner, logs never go to the real server/logs folder', async () => {
  const { env } = await import('../src/env.js');
  if (process.env.LOG_DIR) return; // an explicit folder was given for this run
  assert.notEqual(env.logDir, path.join(serverDir, 'logs'));
  assert.match(env.logDir, /support-tyrescart-test-logs$/);
});
