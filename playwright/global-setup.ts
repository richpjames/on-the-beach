import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Build the SvelteKit app once before any worker boots a server from
 * `build/index.js`. Set PLAYWRIGHT_SKIP_BUILD=1 to reuse an existing build
 * (useful when iterating on tests without app changes).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.PLAYWRIGHT_SKIP_BUILD === "1") {
    return;
  }

  const child = spawn("bun", ["run", "build"], { stdio: "inherit" });
  const [exitCode] = await once(child, "exit");
  if (exitCode !== 0) {
    throw new Error(`bun run build failed with exit code ${exitCode}`);
  }
}
