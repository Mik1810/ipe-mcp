import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
function decodeToken(text: string): Buffer | undefined {
  if (!tokenPattern.test(text)) return undefined;
  const decoded = Buffer.from(text, "base64url");
  return decoded.toString("base64url") === text ? decoded : undefined;
}

function within(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(".." + sep);
}

export async function readCredential(file: string, workspace: string): Promise<Buffer> {
  const path = resolve(file);
  const parent = dirname(path);
  if (await realpath(parent) !== parent || within(workspace, path)) throw new Error("Invalid credential location");
  const directory = await stat(parent);
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("Credential directory is not private");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || (info.size !== 43 && info.size !== 44)) {
      throw new Error("Invalid credential file");
    }
    const bytes = Buffer.alloc(45);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("Invalid credential file");
    const token = decodeToken(bytes.subarray(0, bytesRead).toString("utf8").replace(/\n$/u, ""));
    if (token === undefined) throw new Error("Invalid credential");
    return token;
  } finally {
    await handle.close();
  }
}

export function matchesCredential(value: string | undefined, credential: Buffer): boolean {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(value ?? "");
  const supplied = match?.[1] === undefined ? undefined : decodeToken(match[1]);
  return supplied !== undefined && timingSafeEqual(supplied, credential);
}

/** Lock the opened directory inode itself. An atomic file replacement cannot bypass this lease. */
export async function claimStateRoot(stateRoot: string, workspace: string): Promise<FileHandle> {
  const path = resolve(stateRoot);
  if (path === workspace || !within(workspace, path) || await realpath(dirname(path)) !== dirname(path)) throw new Error("Invalid state root");
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directory = await handle.stat();
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("State root is not private");
    await new Promise<void>((resolve, reject) => {
      // Linux flock is associated with the open file description shared with fd 3.
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error("State root is already in use or locking is unavailable")));
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
