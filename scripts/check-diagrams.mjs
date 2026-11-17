// Checks the sequence diagrams in docs/diagrams/ against the contract and renders them.
//   [CT-2.a] each expected file holds exactly one Mermaid sequence diagram
//   [CT-2.b] each expected diagram shows its error paths (the codes and steps listed below)
//   [CT-2.c] in every diagram, every Client -> API arrow is an operation of api/openapi.yaml,
//            and every API -> Client arrow uses a status (and error `code`) it documents
//   [CT-2.d] mermaid-cli renders every diagram in docs/diagrams/*.md to SVG
// `--no-render` skips CT-2.d: the diagram-vs-contract half runs in `npm run check` without Chrome.
// The arrow convention the check relies on: the client is participant `C`, the API is `API`;
// requests are `C->>API: POST /api/v1/...`, answers are `API-->>C: 401 PASSCODE_INVALID`.
// Any Mermaid arrow form between the two counts (->, -->, ->>, -x, -), with or without +/-).
// Rendering uses a local Chrome (PUPPETEER_EXECUTABLE_PATH, default /usr/bin/google-chrome).
// Exits 1 on any failure. Plain JavaScript, like check-postman.mjs.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT = 'api/openapi.yaml';
const DIR = 'docs/diagrams';
const MERMAID_CLI = '@mermaid-js/mermaid-cli@12.2.0';
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/google-chrome';
const RENDER = !process.argv.slice(2).includes('--no-render');

/** File -> what its diagram must contain to show its error paths [CT-2.b]. */
const DIAGRAMS = {
  'signup-passcode.md': {
    codes: ['VALIDATION_FAILED', 'EMAIL_TAKEN', 'PASSCODE_INVALID'],
    text: ['expired', 'POST /api/v1/auth/otp/resend', 'already pending'],
  },
  'login.md': {
    codes: ['INVALID_CREDENTIALS'],
    text: ['pending'],
  },
  'password-reset.md': {
    codes: ['PASSCODE_INVALID', 'RATE_LIMITED'],
    text: ['expired', 'POST /api/v1/auth/password/forgot', 'POST /api/v1/auth/password/reset'],
  },
  'transfer.md': {
    codes: ['RECIPIENT_NOT_FOUND', 'INSUFFICIENT_FUNDS'],
    text: ['abortTransaction', 'rollback'],
  },
};

/** A message line: from, arrow, to, label. */
const ARROW = /^\s*(\w+)\s*(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*(\w+)\s*:\s*(.*)$/;
const ERROR_CODE = /\b[A-Z]{2,}(?:_[A-Z]+)+\b|\b[A-Z]{5,}\b/g;

/**
 * @typedef {{ responses: Record<string, { content?: Record<string, { examples?: Record<string, unknown> }> }> }} Operation
 * @typedef {{ paths: Record<string, Record<string, Operation>> }} Contract
 */

/** @type {string[]} */
const failures = [];
/** @param {string} criterion @param {string} message */
const fail = (criterion, message) => failures.push(`[${criterion}] ${message}`);

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, env) {
  try {
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const { stdout = '', stderr = '' } = /** @type {{ stdout?: string, stderr?: string }} */ (
      error
    );
    throw new Error(`${command} ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error });
  }
}

/** @param {string} markdown @returns {string[]} the bodies of its ```mermaid blocks */
function mermaidBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n');
  return [...lines.matchAll(/^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
}

/**
 * @param {Contract} contract
 * @param {string} method upper case
 * @param {string} path may carry a query string or concrete values for `{param}` segments
 * @returns {{ label: string, operation: Operation } | undefined}
 */
function findOperation(contract, method, path) {
  const bare = path.split('?')[0];
  for (const [template, item] of Object.entries(contract.paths)) {
    const pattern = template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+');
    const operation = item[method.toLowerCase()];
    if (operation && new RegExp(`^${pattern}$`).test(bare)) {
      return { label: `${method} ${template}`, operation };
    }
  }
  return undefined;
}

/**
 * [CT-2.c] Walks the arrows in order; each answer belongs to the latest request.
 * @param {string} file
 * @param {string} diagram
 * @param {Contract} contract
 * @param {Set<string>} errorCodes the contract's ErrorCode enum
 */
function checkArrows(file, diagram, contract, errorCodes) {
  /** @type {{ label: string, operation: Operation } | undefined} */
  let current;
  let requests = 0;
  for (const line of diagram.split('\n')) {
    const arrow = ARROW.exec(line);
    if (!arrow) continue;
    const [, from, to, text] = arrow;
    if (from === 'C' && to === 'API') {
      requests += 1;
      const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/.exec(text);
      current = match ? findOperation(contract, match[1], match[2]) : undefined;
      if (!current) fail('CT-2.c', `${file}: request "${text}" is not an operation of ${CONTRACT}`);
      continue;
    }
    if (from !== 'API' || to !== 'C') continue;
    if (!current) {
      fail('CT-2.c', `${file}: answer "${text}" follows no valid request`);
      continue;
    }
    const status = /^(\d{3})\b(.*)$/.exec(text);
    if (!status) {
      fail('CT-2.c', `${file}: answer "${text}" does not start with a status code`);
      continue;
    }
    const documented = current.operation.responses[status[1]];
    if (!documented) {
      fail('CT-2.c', `${file}: ${current.label} documents no ${status[1]}`);
      continue;
    }
    const codes = status[2].match(ERROR_CODE) ?? [];
    for (const code of codes.filter((word) => !errorCodes.has(word))) {
      fail('CT-2.c', `${file}: ${code} is not in the contract's ErrorCode enum`);
    }
    if (Number(status[1]) >= 400 && codes.length === 0) {
      fail('CT-2.c', `${file}: error answer "${text}" names no error code`);
    }
    const examples = Object.values(documented.content ?? {}).flatMap((media) =>
      Object.keys(media.examples ?? {}),
    );
    for (const code of codes) {
      if (!examples.includes(code)) {
        fail('CT-2.c', `${file}: ${current.label} ${status[1]} does not document ${code}`);
      }
    }
  }
  if (requests === 0) fail('CT-2.c', `${file}: no C->>API request arrows`);
}

let checked = 0;
const dir = mkdtempSync(join(tmpdir(), 'check-diagrams-'));
try {
  const bundled = join(dir, 'openapi.json');
  run('npx', ['redocly', 'bundle', CONTRACT, '--dereferenced', '--ext', 'json', '-o', bundled]);
  /** @type {Contract & { components: { schemas: { ErrorCode: { enum: string[] } } } }} */
  const contract = JSON.parse(readFileSync(bundled, 'utf8'));
  const errorCodes = new Set(contract.components.schemas.ErrorCode.enum);

  const puppeteerConfig = join(dir, 'puppeteer.json');
  writeFileSync(puppeteerConfig, JSON.stringify({ executablePath: CHROME }));

  for (const [file, required] of Object.entries(DIAGRAMS)) {
    const path = join(DIR, file);
    if (!existsSync(path)) {
      fail('CT-2.a', `${path} is missing`);
      continue;
    }
    const blocks = mermaidBlocks(readFileSync(path, 'utf8'));
    if (blocks.length !== 1 || !/^\s*sequenceDiagram\b/.test(blocks[0])) {
      fail('CT-2.a', `${path} must hold exactly one mermaid sequenceDiagram block`);
      continue;
    }
    const answers = blocks[0]
      .split('\n')
      .map((line) => ARROW.exec(line))
      .filter((arrow) => arrow?.[1] === 'API' && arrow[2] === 'C')
      .map((arrow) => arrow?.[3] ?? '');
    for (const code of required.codes) {
      if (!answers.some((answer) => new RegExp(`\\b${code}\\b`).test(answer))) {
        fail('CT-2.b', `${file}: no answer with ${code}`);
      }
    }
    for (const text of required.text) {
      if (!blocks[0].includes(text)) fail('CT-2.b', `${file}: does not show "${text}"`);
    }
  }

  const files = readdirSync(DIR).filter((name) => name.endsWith('.md'));
  for (const file of files) {
    for (const [index, diagram] of mermaidBlocks(readFileSync(join(DIR, file), 'utf8')).entries()) {
      checked += 1;
      checkArrows(file, diagram, contract, errorCodes);
      if (!RENDER) continue;

      const input = join(dir, `${file.replace(/\.md$/, '')}-${index + 1}.mmd`);
      const output = input.replace(/\.mmd$/, '.svg');
      writeFileSync(input, diagram);
      try {
        run('npx', ['--yes', MERMAID_CLI, '-q', '-i', input, '-o', output, '-p', puppeteerConfig], {
          PUPPETEER_SKIP_DOWNLOAD: '1',
        });
        if (!existsSync(output) || statSync(output).size === 0) {
          fail('CT-2.d', `${file}: mermaid-cli wrote no SVG`);
        }
      } catch (error) {
        fail('CT-2.d', `${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`check:diagrams: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `check:diagrams: ${checked} diagrams match ${CONTRACT}` +
      (RENDER ? ` and render with ${MERMAID_CLI}` : ' (rendering skipped: --no-render)'),
  );
}
