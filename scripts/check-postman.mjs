// Imports the contract the way Postman does (openapi-to-postmanv2) and checks that the
// collection holds exactly one request per operation. Exits 1 on a failed conversion or a
// count mismatch. Plain JavaScript, outside tsc's include list until @types/node arrives with
// the server; the JSDoc types document the shapes it reads.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/**
 * Runs a command that must write `outputFile`; on failure prints the command's own output.
 * @param {string[]} args arguments to npx
 * @param {string} outputFile
 */
function npx(args, outputFile) {
  try {
    execFileSync('npx', args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const { stdout = '', stderr = '' } = /** @type {{ stdout?: string, stderr?: string }} */ (
      error
    );
    throw new Error(`npx ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error });
  }
  if (!existsSync(outputFile)) {
    throw new Error(`npx ${args.join(' ')} wrote no ${outputFile}`);
  }
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const dir = mkdtempSync(join(tmpdir(), 'check-postman-'));
try {
  const bundled = join(dir, 'openapi.json');
  const collectionFile = join(dir, 'collection.json');

  npx(['redocly', 'bundle', CONTRACT, '--ext', 'json', '-o', bundled], bundled);
  npx(['--yes', CONVERTER, '-s', CONTRACT, '-o', collectionFile], collectionFile);

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
} catch (error) {
  console.error(`check:postman: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
