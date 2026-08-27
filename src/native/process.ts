import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";

import { NativeIpeError, type NativeErrorCode } from "./errors.js";

export interface ProcessLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxProcesses: number;
  readonly maxFileBytes: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export async function runControlledProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  limits: ProcessLimits,
  failureCode: NativeErrorCode,
  environment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  const started = Date.now();
  if (process.platform === "linux") await attestBubblewrap();
  const remainingTimeout = limits.timeoutMs - (Date.now() - started);
  if (remainingTimeout < 1) throw new NativeIpeError("NATIVE_TIMEOUT", `native process exceeded ${limits.timeoutMs} ms before spawn`);
  return await new Promise<ProcessResult>((resolve, reject) => {
    const launchExecutable = process.platform === "linux" ? "/usr/bin/bwrap" : executable;
    const launchArgs = process.platform === "linux"
      ? [
        "--unshare-user", "--unshare-pid", "--die-with-parent", "--new-session",
        "--ro-bind", "/", "/", "--bind", cwd, cwd, "--proc", "/proc", "--dev", "/dev", "--chdir", cwd, "--",
        "/usr/bin/prlimit", `--as=${limits.maxMemoryBytes}`, `--nproc=${limits.maxProcesses}`, `--fsize=${limits.maxFileBytes}`, "--", executable, ...args,
      ]
      : [...args];
    const child = spawn(launchExecutable, launchArgs, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...environment },
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let limitError: NativeIpeError | undefined;
    const finish = (error?: Error, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(result!);
    };
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (limitError !== undefined) return;
      outputBytes += chunk.length;
      if (outputBytes > limits.maxOutputBytes) {
        limitError = new NativeIpeError("NATIVE_OUTPUT_LIMIT", `native output exceeded ${limits.maxOutputBytes} bytes`);
        killTree(child.pid);
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error) => { killTree(child.pid); finish(new NativeIpeError("NATIVE_UNAVAILABLE", "cannot start native executable", [], { cause: error })); });
    child.on("exit", () => killTree(child.pid));
    child.on("close", (code, signal) => {
      if (limitError !== undefined) return finish(limitError);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) finish(undefined, { stdout: out, stderr: err });
      else if (signal !== null || (code !== null && code >= 128)) finish(new NativeIpeError("NATIVE_CRASH", `native process terminated by ${signal ?? `status ${code}`}`, compact(err)));
      else finish(new NativeIpeError(failureCode, `native process exited with status ${code ?? "unknown"}`, compact(err)));
    });
    const timer = setTimeout(() => {
      limitError = new NativeIpeError("NATIVE_TIMEOUT", `native process exceeded ${limits.timeoutMs} ms`);
      killTree(child.pid);
    }, remainingTimeout);
    timer.unref();
  });
}

let bubblewrapAttestation: Promise<void> | undefined;
export async function attestBubblewrap(): Promise<void> {
  bubblewrapAttestation ??= (async () => {
    const resolved = await realpath("/usr/bin/bwrap");
    if (resolved !== "/usr/bin/bwrap") throw new Error("bubblewrap path does not resolve to the fixed executable");
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(4);
      if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("bubblewrap is not an ELF executable");
    } finally { await handle.close(); }
    const files = await readFile("/var/lib/dpkg/info/bubblewrap.list", "utf8");
    if (!files.split("\n").includes("/usr/bin/bwrap")) throw new Error("bubblewrap package does not own /usr/bin/bwrap");
    const status = await readFile("/var/lib/dpkg/status", "utf8");
    const stanza = status.split(/\n\n/u).find((item) => /^Package: bubblewrap$/mu.test(item));
    if (stanza === undefined || !/^Status: install ok installed$/mu.test(stanza) || !/^Version: 0\.11\.1(?:[-+~]|$)/mu.test(stanza)) throw new Error("bubblewrap 0.11.1 package attestation failed");
  })().catch((error) => { bubblewrapAttestation = undefined; throw new NativeIpeError("NATIVE_UNAVAILABLE", "bubblewrap isolation attestation failed", [], { cause: error }); });
  await bubblewrapAttestation;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // The process may have exited between the limit check and the signal.
  }
}

function compact(value: string): readonly string[] {
  // Only stable bridge markers cross the trust boundary. In particular, do not
  // return TeX's result/log fields: they can contain source text and host paths.
  const markers = value.match(/^IPE_M6_(?:ERROR|RESULT)=[A-Za-z0-9_.-]{1,40}$/gmu) ?? [];
  return markers.slice(0, 12);
}
