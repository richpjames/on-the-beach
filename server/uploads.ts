import path from "node:path";

const DEFAULT_UPLOADS_DIR = "uploads";
const UPLOADS_ROUTE_PREFIX = "/uploads";

export function getUploadsDir(): string {
  const configuredDir = process.env.UPLOADS_DIR?.trim();

  if (!configuredDir) {
    return path.resolve(process.cwd(), DEFAULT_UPLOADS_DIR);
  }

  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(process.cwd(), configuredDir);
}

export function toUploadsPublicPath(filename: string): string {
  return `${UPLOADS_ROUTE_PREFIX}/${filename}`;
}

export function rewriteUploadsRequestPath(requestPath: string): string {
  if (!requestPath.startsWith(UPLOADS_ROUTE_PREFIX)) {
    return requestPath;
  }

  return requestPath.slice(UPLOADS_ROUTE_PREFIX.length) || "/";
}
