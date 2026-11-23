// Runs the Cypress browser tests against the real app: builds the client, starts a throwaway
// MongoDB replica set and, for each spec file, a fresh API server and a preview of the build.
// The API's rate limits live in its process memory, so a fresh server gives each file its own.
// Exits 0 when every spec passed, 1 otherwise.
//
//   npm run test:e2e                                          every spec
//   npm run test:e2e -- --spec client/cypress/e2e/foo.cy.ts   one spec (repeat for more)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cypress from 'cypress';
import memoryServer from 'mongodb-memory-server';
import { build, preview } from 'vite';

const { MongoMemoryReplSet } = memoryServer;

const SPEC_DIR = 'client/cypress/e2e';
const READY_TIMEOUT_MS = 30_000;

const secret = () => randomBytes(32).toString('base64');

/** @type {Set<import('node:child_process').ChildProcess>} */
const running = new Set();
/** @type {import('mongodb-memory-server').MongoMemoryReplSet | undefined} */
let database;
/** @type {import('vite').PreviewServer | undefined} */
let site;
let passedTests = 0;

function stopProcess(/** @type {import('node:child_process').ChildProcess} */ child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Started detached, so this reaches npx's children too.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

for (const [signal, code] of /** @type {const} */ ([
  ['SIGINT', 130],
  ['SIGTERM', 143],
])) {
  process.on(signal, () => {
    running.forEach(stopProcess);
    void Promise.allSettled([site?.close(), database?.stop()]).finally(() => process.exit(code));
  });
}

function specsToRun() {
  const args = process.argv.slice(2);
  const specs = args.flatMap((arg, index) => (args[index - 1] === '--spec' ? [resolve(arg)] : []));
  if (specs.length > 0) return specs;
  return readdirSync(SPEC_DIR)
    .filter((name) => name.endsWith('.cy.ts'))
    .sort()
    .map((name) => resolve(join(SPEC_DIR, name)));
}

/**
 * Starts the API on a port the OS picks and resolves with it once it listens on MongoDB.
 * @param {string} mongodbUri
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number }>}
 */
function startApi(mongodbUri) {
  return new Promise((resolvePort, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
      // Only what the server needs: the caller's shell can't change the run.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'test',
        PORT: '0',
        LOG_LEVEL: 'info',
        MAILER: 'outbox',
        JWT_SECRET: secret(),
        PASSCODE_SECRET: secret(),
        MONGODB_URI: mongodbUri,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    running.add(child);
    child.on('close', () => running.delete(child));

    let settled = false;
    let pending = '';
    let stderr = '';
    const fail = (/** @type {string} */ reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${reason}${stderr ? `\n${stderr.trim()}` : ''}`));
    };
    const timer = setTimeout(() => fail('the API did not start in time'), READY_TIMEOUT_MS);
    // Keep reading after it starts, or a full pipe would block the server.
    child.stdout.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (settled) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.msg === 'server listening' && Number.isInteger(entry.port)) {
            if (entry.storage !== 'mongodb') {
              fail(`the API listens on ${entry.storage} storage, not MongoDB`);
              continue;
            }
            settled = true;
            clearTimeout(timer);
            resolvePort({ child, port: entry.port });
          }
        } catch {
          // not a JSON line: ignore
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      if (!settled) stderr += chunk;
    });
    child.on('error', (error) => fail(`could not start the API: ${error.message}`));
    child.on('close', (code) => fail(`the API exited early (code ${code})`));
  });
}

/**
 * @param {string} spec
 * @param {string} appUrl
 * @param {string} apiUrl
 * @returns {Promise<boolean>}
 */
async function runCypress(spec, appUrl, apiUrl) {
  try {
    const result = await cypress.run({
      // Chrome: in the bundled Electron, run headless, the app's animations stayed at time 0.
      browser: 'chrome',
      project: 'client',
      spec,
      config: { baseUrl: appUrl, expose: { apiUrl } },
    });
    if (result.status === 'failed') {
      console.error(`test:e2e: Cypress could not run ${spec}: ${result.message}`);
      return false;
    }
    // A run can end cleanly without finishing its tests, which must never count as a pass.
    if (result.totalTests === 0 || result.totalPassed !== result.totalTests) {
      console.error(
        `test:e2e: ${spec}: ${result.totalPassed} of ${result.totalTests} tests passed`,
      );
      return false;
    }
    passedTests += result.totalPassed;
    return true;
  } catch (error) {
    console.error(`test:e2e: could not run Cypress: ${error.message}`);
    return false;
  }
}

let exitCode = 1;
try {
  const specs = specsToRun();
  if (specs.length === 0) throw new Error(`no spec files in ${SPEC_DIR}`);

  await build({ root: 'client', logLevel: 'warn' });
  // Transactions need a replica set. The first run on a machine downloads mongod (~120 MB).
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  const failed = [];
  for (const [index, spec] of specs.entries()) {
    const { child: api, port } = await startApi(database.getUri(`e2e-${index}`));
    const target = `http://127.0.0.1:${port}`;
    site = await preview({
      root: 'client',
      logLevel: 'warn',
      preview: {
        host: '127.0.0.1',
        port: 4173,
        strictPort: false,
        proxy: { '/api': target },
      },
    });
    const appUrl = site.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!appUrl) throw new Error('the preview server has no address');

    const passed = await runCypress(spec, appUrl, target);
    if (!passed) failed.push(spec);

    await site.close();
    site = undefined;
    api.removeAllListeners('close');
    running.delete(api);
    stopProcess(api);
  }

  if (failed.length > 0) console.error(`test:e2e: failed:\n  ${failed.join('\n  ')}`);
  else console.log(`test:e2e: ${passedTests} tests passed in ${specs.length} spec files`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`test:e2e: ${error instanceof Error ? error.message : error}`);
} finally {
  running.forEach(stopProcess);
  await site?.close();
  await database?.stop();
}
process.exit(exitCode);
