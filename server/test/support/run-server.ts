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

export type Started = {
  /** The parsed "server listening" line. */
  listening: { address?: string; port: number; nodeEnv: string; storage: string };
  /** Everything the process printed so far. */
  output(): string;
  stop(): Promise<void>;
};

/**
 * Runs src/server.ts like `runServer`, for a server that should keep running: resolves at its
 * "server listening" line, or rejects with its output if it exits or takes 20 s first.
 */
export function startServer(variables: NodeJS.ProcessEnv): Promise<Started> {
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
    });
    let out = '';
    const exited = new Promise<void>((settle) => child.on('close', () => settle()));
    const stop = async () => {
      child.kill();
      await exited;
    };
    const timer = setTimeout(() => {
      void stop().then(() => fail(new Error(`no "server listening" line in 20 s:\n${out}`)));
    }, 20000);
    child.on('close', (status) => {
      clearTimeout(timer);
      fail(new Error(`the server exited with ${String(status)}:\n${out}`));
    });
    const onData = (chunk: string) => {
      out += chunk;
      const line = out.split('\n').find((text) => text.includes('"server listening"'));
      if (!line) return;
      clearTimeout(timer);
      done({ listening: JSON.parse(line) as Started['listening'], output: () => out, stop });
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  });
}
