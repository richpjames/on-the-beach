import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { once } from "node:events";
import { test as base, expect } from "@playwright/test";

const SERVER_BASE_PORT = Number(process.env.PLAYWRIGHT_SERVER_BASE_PORT ?? "4500");
const SERVER_START_TIMEOUT_MS = 90_000;

type WorkerFixtures = {
  workerBaseURL: string;
};

export const test = base.extend<{}, WorkerFixtures>({
  workerBaseURL: [
    async ({ playwright }, use, workerInfo) => {
      void playwright;
      const port = SERVER_BASE_PORT + workerInfo.workerIndex;
      const databasePath = `/tmp/on_the_beach.playwright.worker-${workerInfo.workerIndex}.db`;
      const env = {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "test",
        DATABASE_PATH: databasePath,
      };

      clearDatabaseFiles(databasePath);
      await runCommand(["server/db/seed.ts"], env);

      const server = spawn("bun", ["server/index.ts"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const logs = collectLogs(server);

      try {
        await waitForServer(`http://127.0.0.1:${port}/api/music-items`, SERVER_START_TIMEOUT_MS);
      } catch (error) {
        await stopServer(server);
        throw new Error(
          `Failed to start worker server on port ${port}: ${(error as Error).message}\n${logs()}`,
        );
      }

      try {
        await use(`http://127.0.0.1:${port}`);
      } finally {
        await stopServer(server);
        clearDatabaseFiles(databasePath);
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],

  contextOptions: async ({ contextOptions, workerBaseURL }, use) => {
    await use({
      ...contextOptions,
      baseURL: workerBaseURL,
    });
  },

  request: async ({ playwright, workerBaseURL }, use) => {
    const request = await playwright.request.newContext({
      baseURL: workerBaseURL,
    });
    await use(request);
    await request.dispose();
  },
});

export { expect };

function clearDatabaseFiles(databasePath: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function collectLogs(server: ChildProcess): () => string {
  const chunks: string[] = [];
  server.stdout?.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()));
  server.stderr?.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()));
  return () => chunks.join("");
}

async function runCommand(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn("bun", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = collectLogs(child);
  const [exitCode] = await once(child, "exit");

  if (exitCode !== 0) {
    throw new Error(`Command failed: bun ${args.join(" ")}\n${logs()}`);
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout while the worker server boots.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }

  server.kill("SIGTERM");
  const exited = once(server, "exit");
  const timeout = delay(5_000).then(() => "timeout");
  const result = await Promise.race([exited, timeout]);

  if (result === "timeout" && server.exitCode === null) {
    server.kill("SIGKILL");
    await once(server, "exit");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
