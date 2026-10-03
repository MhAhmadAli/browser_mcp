import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const tokenPath = path.join(os.homedir(), ".browser-mcp", "token");

/**
 * Returns the pairing token the browser extension must present, creating it on first use.
 */
export async function getOrCreateToken(): Promise<string> {
  const existing = await readToken();
  if (existing) {
    return existing;
  }

  const directory = path.dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's permissions as they are
  await chmod(directory, 0o700);
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
    // Another server instance created it first
    const created = await readToken();
    if (!created) {
      throw new Error(
        `${tokenPath} exists but is empty. Delete it to generate a new token.`,
      );
    }
    return created;
  }
}

async function readToken(): Promise<string | undefined> {
  try {
    return (await readFile(tokenPath, "utf8")).trim() || undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
