import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test as base, expect } from "@playwright/test";

const SERVER_BASE_PORT = parseConfiguredBasePort(process.env.PLAYWRIGHT_SERVER_BASE_PORT);
const SERVER_START_TIMEOUT_MS = 90_000;
const SERVER_START_MAX_ATTEMPTS = 5;

type WorkerFixtures = {
  workerBaseURL: string;
};

export const test = base.extend<{}, WorkerFixtures>({
  workerBaseURL: [
    async ({ playwright }, use, workerInfo) => {
      void playwright;
      const workerTempDir = mkdtempSync(
        join(
          tmpdir(),
          `on-the-beach-playwright-${workerInfo.parallelIndex}-${workerInfo.workerIndex}-`,
        ),
      );
      const databasePath = join(workerTempDir, "worker.db");
      const env = {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_PATH: databasePath,
      };

      clearDatabaseFiles(databasePath);
      await runCommand(["server/db/seed.ts"], env);
      const preferredPort =
        SERVER_BASE_PORT === null ? null : SERVER_BASE_PORT + workerInfo.workerIndex;
      const { port, server } = await startWorkerServer(env, preferredPort);

      try {
        await use(`http://127.0.0.1:${port}`);
      } finally {
        await stopServer(server);
        clearDatabaseFiles(databasePath);
        rmSync(workerTempDir, { recursive: true, force: true });
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

function parseConfiguredBasePort(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

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

async function startWorkerServer(
  baseEnv: NodeJS.ProcessEnv,
  preferredPort: number | null,
): Promise<{ port: number; server: ChildProcess }> {
  const attemptedPorts = new Set<number>();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < SERVER_START_MAX_ATTEMPTS; attempt += 1) {
    const port = await getNextWorkerPort(preferredPort, attemptedPorts);
    attemptedPorts.add(port);
    const env = {
      ...baseEnv,
      PORT: String(port),
    };

    const server = spawn("bun", ["server/index.ts"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = collectLogs(server);

    try {
      await waitForServer(`http://127.0.0.1:${port}/api/music-items`, SERVER_START_TIMEOUT_MS);
      return { port, server };
    } catch (error) {
      const message = `Failed to start worker server on port ${port}: ${(error as Error).message}\n${logs()}`;
      await stopServer(server);
      lastError = new Error(message);

      if (!isRetryablePortFailure(message)) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Failed to start worker server");
}

async function getNextWorkerPort(
  preferredPort: number | null,
  attemptedPorts: Set<number>,
): Promise<number> {
  if (preferredPort !== null && !attemptedPorts.has(preferredPort)) {
    return preferredPort;
  }

  for (;;) {
    const port = await getAvailablePort();
    if (!attemptedPorts.has(port)) {
      return port;
    }
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();

    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Failed to determine available port"));
        return;
      }

      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function isRetryablePortFailure(message: string): boolean {
  return message.includes("Is port") && message.includes("in use");
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
