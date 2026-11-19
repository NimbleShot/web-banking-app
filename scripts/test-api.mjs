// Runs the Postman flow collection against a real server: starts a throwaway MongoDB replica set,
// then server/src/server.ts on a port the OS picks, with fresh secrets, the in-memory outbox and
// that database, waits until it listens on MongoDB, runs newman against it and always stops both.
// Exits 0 when newman passed, 1 otherwise (a failed assertion, a server or database that did not
// start, a spawn error).
//
//   npm run test:api                  stop at the first failed assertion
//   npm run test:api -- --keep-going  run every request and list every failed assertion
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import memoryServer from 'mongodb-memory-server';

const { MongoMemoryReplSet } = memoryServer;

const NEWMAN = 'newman@6.2.3';
const COLLECTION = 'server/postman/flow.postman_collection.json';
const ENVIRONMENT = 'server/postman/local.postman_environment.json';
const READY_TIMEOUT_MS = 30_000;
const keepGoing = process.argv.includes('--keep-going');

const secret = () => randomBytes(32).toString('base64');

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {import('node:child_process').ChildProcess | undefined} */
let newman;
/** @type {import('mongodb-memory-server').MongoMemoryReplSet | undefined} */
let database;
let stopping = false;

function stopChildren() {
  if (server?.pid !== undefined && server.exitCode === null) server.kill('SIGTERM');
  // newman runs in its own process group (npx starts it as a child): stop the whole group.
  if (newman?.pid !== undefined && newman.exitCode === null) {
    try {
      process.kill(-newman.pid, 'SIGTERM');
    } catch {
      newman.kill('SIGTERM');
    }
  }
}

process.on('exit', stopChildren);
for (const [signal, code] of /** @type {const} */ ([
  ['SIGINT', 130],
  ['SIGTERM', 143],
])) {
  process.on(signal, () => {
    stopping = true;
    stopChildren();
    // Stopping the replica set also removes its data folder; exit even if that fails.
    void Promise.resolve(database?.stop())
      .catch(() => undefined)
      .finally(() => process.exit(code));
  });
}

/**
 * Starts the server on the database at `mongodbUri` and resolves with its port once it logs
 * `server listening` on MongoDB. The server's stdout keeps being read afterwards, or a full pipe
 * would block it.
 * @param {string} mongodbUri
 * @returns {Promise<number>}
 */
function startServer(mongodbUri) {
  return new Promise((resolve, reject) => {
    // Only what the server needs: a variable set in the caller's shell (TRUST_PROXY,
    // CORS_ORIGIN, ...) can't change the run.
    const env = {
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
    };
    server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    let stderr = '';
    let settled = false;
    const fail = (/** @type {string} */ reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${reason}${stderr ? `\n${stderr.trim()}` : ''}`));
    };
    const timer = setTimeout(
      () => fail(`the server did not start listening within ${READY_TIMEOUT_MS / 1000} s`),
      READY_TIMEOUT_MS,
    );
    server.stdout?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (settled) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.msg === 'server listening' && Number.isInteger(entry.port)) {
            // The flow must run on the database, not on a silent fallback to memory.
            if (entry.storage !== 'mongodb') {
              fail(`the server listens on ${entry.storage} storage, not MongoDB`);
              continue;
            }
            settled = true;
            clearTimeout(timer);
            resolve(entry.port);
          }
        } catch {
          // not a JSON line: ignore
        }
      }
    });
    // Only a start-up failure needs the server's stderr (a ConfigError): once it listens, drop it.
    server.stderr?.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => {
      if (!settled) stderr += chunk;
    });
    server.on('error', (error) => fail(`could not start the server: ${error.message}`));
    server.on('close', (code, signal) => {
      if (!stopping) fail(`the server exited early (code ${code}, signal ${signal})`);
    });
  });
}

/**
 * @param {number} port
 * @returns {Promise<number>} 0 when newman exited 0 and was not killed by a signal, else 1
 */
function runNewman(port) {
  return new Promise((resolve) => {
    const args = [
      '--yes',
      NEWMAN,
      'run',
      COLLECTION,
      '-e',
      ENVIRONMENT,
      '--env-var',
      `baseUrl=http://127.0.0.1:${port}`,
      '--timeout-request',
      '10000',
      '--timeout',
      '120000',
    ];
    if (!keepGoing) args.push('--bail');
    newman = spawn('npx', args, { stdio: 'inherit', detached: true });
    newman.on('error', (error) => {
      console.error(`test:api: could not run ${NEWMAN}: ${error.message}`);
      resolve(1);
    });
    newman.on('close', (code, signal) => resolve(code === 0 && signal === null ? 0 : 1));
  });
}

let exitCode = 1;
try {
  // Transactions need a replica set. The first run on a machine downloads mongod (~120 MB).
  database = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const port = await startServer(database.getUri('bank'));
  console.log(`test:api: server listening on port ${port}, on MongoDB`);
  exitCode = await runNewman(port);
} catch (error) {
  console.error(`test:api: ${error instanceof Error ? error.message : error}`);
} finally {
  stopChildren();
  await database?.stop();
}
process.exitCode = exitCode;
