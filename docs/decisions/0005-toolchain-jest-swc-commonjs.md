---
status: accepted
date: 2026-11-13
---
# 0009. Toolchain: npm workspaces, TS 6.0, CommonJS server, Jest with @swc/jest

**Context.** Every later phase builds and tests with the same tools. On 13 Nov 2026 TS 7 is npm
`latest`, but typescript-eslint accepts `<6.1`. Jest's ESM support is still experimental, and the
worksheet names Jest.

**Options.** Tests: Jest + `@swc/jest` (types stripped, fast) · Jest + `ts-jest` (type-checked on
every run, slower) · Vitest (not the worksheet's tool).

**Decision.** Node 24 (`>=24.9 <25`, in `.nvmrc` and `engines`). npm workspaces, added as each
package appears: `api` (phase 1), `server` (phase 2), `client` (phase 5). TypeScript is pinned `~6.0`. The
server compiles to CommonJS. Tests run on Jest with `@swc/jest`. Types are checked by
`tsc --noEmit` as its own step of `npm run check`, not during tests. Dev runs on `tsx watch`.
ESLint 10 (flat config) with typescript-eslint, and Prettier.

**Consequences.** Test runs stay fast. A type error fails `npm run check`, not the test run.
Swapping to `ts-jest` later is one line of Jest config. TS 7 waits until typescript-eslint
supports it; `npm outdated` before each phase watches for that.
