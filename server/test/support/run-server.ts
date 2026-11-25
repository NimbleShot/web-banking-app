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
    let timedOut = false;
    const exited = new Promise<void>((settle) => child.on('close', () => settle()));
    const stop = async () => {
      child.kill();
      await exited;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, 20000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const why = timedOut
        ? 'no "server listening" line in 20 s'
        : `the server exited with ${String(status)}`;
      fail(new Error(`${why}:\n${out}`));
    });
    const onData = (chunk: string) => {
      out += chunk;
      // Only whole lines: a chunk can end inside one.
      const line = out
        .split('\n')
        .slice(0, -1)
        .find((text) => text.includes('"server listening"'));
      if (!line) return;
      let listening: Started['listening'];
      try {
        listening = JSON.parse(line) as Started['listening'];
      } catch {
        return;
      }
      clearTimeout(timer);
      done({ listening, output: () => out, stop });
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  });
}
