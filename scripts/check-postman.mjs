// Imports the contract the way Postman does (openapi-to-postmanv2) and checks that the
// collection holds exactly one request per operation. Exits 1 on a failed conversion or a
// count mismatch. Plain JavaScript: tsc checks it once @types/node arrives with the server.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT = 'api/openapi.yaml';
const CONVERTER = 'openapi-to-postmanv2@6.4.3';
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * @typedef {{ name: string, request?: unknown, item?: PostmanItem[] }} PostmanItem
 */

/**
 * @param {PostmanItem[]} items
 * @returns {number}
 */
function countRequests(items) {
  return items.reduce(
    (sum, item) => sum + (item.request ? 1 : 0) + (item.item ? countRequests(item.item) : 0),
    0,
  );
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const dir = mkdtempSync(join(tmpdir(), 'check-postman-'));
try {
  const bundled = join(dir, 'openapi.json');
  const collectionFile = join(dir, 'collection.json');

  execFileSync('npx', ['redocly', 'bundle', CONTRACT, '--ext', 'json', '-o', bundled], {
    stdio: 'ignore',
  });
  execFileSync('npx', ['--yes', CONVERTER, '-s', CONTRACT, '-o', collectionFile], {
    stdio: 'ignore',
  });

  /** @type {{ paths: Record<string, Record<string, unknown>> }} */
  const contract = readJson(bundled);
  const operations = Object.values(contract.paths).flatMap((pathItem) =>
    Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key)),
  ).length;

  /** @type {{ item: PostmanItem[] }} */
  const collection = readJson(collectionFile);
  const requests = countRequests(collection.item);

  if (requests !== operations) {
    console.error(`check:postman: ${requests} requests for ${operations} operations`);
    process.exitCode = 1;
  } else {
    console.log(
      `check:postman: ${CONVERTER} imported ${requests} requests = ${operations} operations`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
