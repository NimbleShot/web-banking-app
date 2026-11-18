// Runs the real entry point, for the tests of start-up behaviour.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export type Run = { status: number | null; stdout: string; stderr: string };

/**
 * Runs src/server.ts with only PATH, HOME, TMPDIR, PORT=0, LOG_LEVEL=info and `variables` set
 * (NODE_ENV included: pass it); it must exit by itself.
 */
export function runServer(variables: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: resolve(__dirname, '../..'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        PORT: '0',
        LOG_LEVEL: 'info',
        ...variables,
      },
      // A server that starts listens forever: it is killed here, and the test fails on its
      // status. Generous, so a cold machine compiling the TypeScript doesn't hit it.
      timeout: 20000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}
