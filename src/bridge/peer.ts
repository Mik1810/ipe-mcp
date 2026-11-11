import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { NATIVE_OPERATION_LIMITS } from "../limits.js";
import { readFileBounded, readHandleBounded } from "../persistence/bounded-read.js";
import { BridgeSpool, type BridgeEntryKey } from "./spool.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().nonnegative();
const attachment = z.object({ sourceStamp: digest });
const receipt = z.object({ revision, snapshotHash: digest }).strict();
const offer = z.object({ baseRevision: revision, targetRevision: revision, baseSnapshotHash: digest, proposalHash: digest }).strict();
const decision = z.object({ decision: z.enum(["approved", "declined"]), proposalHash: digest, baseSnapshotHash: digest }).strict();
const grant = z.object({ epoch: z.string(), sequence: revision, revision, proposalHash: digest }).strict();
const ownership = z.object({ pid: z.string().regex(/^[1-9][0-9]{0,8}$/u), start: z.string().regex(/^[0-9]+$/u), boot: z.uuid(), proposalHash: digest }).strict();
const limit = NATIVE_OPERATION_LIMITS.maxDocumentSourceBytes;

function sha(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceStamp(path: string): Promise<string> {
  const source = resolve(path);
  if (await realpath(source) !== source) throw new Error("Invalid bridge source");
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("Invalid bridge source");
    const bytes = await readHandleBounded(handle, limit);
    const after = await handle.stat({ bigint: true });
    if (after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs) throw new Error("Bridge source changed");
    return sha(String(stat.dev) + ":" + String(stat.ino) + ":" + sha(bytes));
  } finally { await handle.close(); }
}

async function processStart(pid: string): Promise<string | undefined> {
  if (!/^[1-9][0-9]{0,8}$/u.test(pid)) return undefined;
  try {
    const value = await readFile("/proc/" + pid + "/stat", "utf8");
    return value.slice(value.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Local Ipe helper. Every record it writes lives outside the MCP workspace. */
export async function runBridgePeer(args: readonly string[], root: string, workspace: string): Promise<string | Buffer> {
  const [action, epoch, index, source, first, second, third] = args;
  if (epoch === undefined || index === undefined || !/^[0-9]{1,10}$/u.test(index) || source === undefined) throw new Error("Invalid bridge peer arguments");
  const sequence = Number(index);
  const spool = await BridgeSpool.open(root, [workspace]);
  const key = (kind: BridgeEntryKey["kind"], seq = sequence): BridgeEntryKey => ({ epoch, sequence: seq, kind });
  const read = async <T>(kind: BridgeEntryKey["kind"], schema: z.ZodType<T>, seq = sequence): Promise<T> => {
    const record = await spool.read(key(kind, seq));
    if (record === undefined) throw new Error("Bridge peer record is not ready");
    return schema.parse(JSON.parse(record.bytes.toString("utf8")) as unknown);
  };
  const publish = async (kind: BridgeEntryKey["kind"], value: unknown): Promise<void> => {
    await spool.publish(key(kind), Buffer.from(JSON.stringify(value)));
  };
  const invitation = await read("attachment", attachment, 0);
  if (action !== "finish" && action !== "recover" && await sourceStamp(source) !== invitation.sourceStamp) {
    throw new Error("Bridge source changed");
  }
  if (action === "check") return "OK\n";
  if (action === "receipt") return String((await read("receipt", receipt)).revision) + "\n";
  const loadSnapshot = async (path: string | undefined) => {
    if (path === undefined) throw new Error("Bridge snapshot is absent");
    return await readFileBounded(path, limit);
  };
  if (action === "snapshot") {
    if (sequence !== 0) {
      await read("receipt", receipt, sequence - 1);
      if (await spool.read(key("offer")) !== undefined) throw new Error("Bridge proposal is pending");
    }
    await spool.publish(key("snapshot"), await loadSnapshot(first));
    return "OK\n";
  }

  if (sequence < 1) throw new Error("Invalid bridge proposal sequence");
  const offered = await read("offer", offer);
  const previous = await read("receipt", receipt, sequence - 1);
  if (previous.snapshotHash !== offered.baseSnapshotHash || previous.revision !== offered.baseRevision) throw new Error("Bridge baseline differs");
  if (action === "offer") {
    if (sha(await loadSnapshot(first)) !== offered.baseSnapshotHash) throw new Error("Ipe working copy changed");
    const proposal = await spool.read(key("proposal"));
    if (proposal?.sha256 !== offered.proposalHash) throw new Error("Bridge proposal differs");
    return Buffer.concat([
      Buffer.from([offered.baseRevision, offered.targetRevision, offered.proposalHash].join(" ") + "\n"),
      proposal.bytes,
    ]);
  }
  if (action === "decision") {
    if (first !== "approved" && first !== "declined" || second !== offered.proposalHash) throw new Error("Invalid Ipe decision");
    await publish("approval", { decision: first, proposalHash: second, baseSnapshotHash: offered.baseSnapshotHash });
    return "OK\n";
  }

  const approval = await read("approval", decision);
  if (approval.proposalHash !== offered.proposalHash || approval.baseSnapshotHash !== offered.baseSnapshotHash) throw new Error("Ipe decision differs");
  const verifyGrant = async () => {
    const authorized = await read("grant", grant);
    if (authorized.epoch !== epoch || authorized.sequence !== sequence || authorized.revision !== offered.targetRevision
      || authorized.proposalHash !== offered.proposalHash || approval.decision !== "approved"
      || await spool.read(key("receipt")) !== undefined) throw new Error("Ipe grant does not match");
  };
  const claim = async (pid: string | undefined) => {
    if (pid === undefined) throw new Error("Missing Ipe process identity");
    const start = await processStart(pid);
    if (start === undefined) throw new Error("Ipe process is unavailable");
    await verifyGrant();
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    await spool.publishOnce(key("consumed"), Buffer.from(JSON.stringify({ pid, start, boot, proposalHash: offered.proposalHash })));
  };
  if (action === "ready") { await verifyGrant(); return "OK\n"; }
  if (action === "claim") {
    if (first !== offered.proposalHash) throw new Error("Ipe grant does not match the reviewed proposal");
    await claim(second);
    return "OK\n";
  }
  if (action !== "finish" && action !== "recover") throw new Error("Unknown bridge peer action");
  if (second !== "applied" && second !== "unchanged") throw new Error("Invalid Ipe outcome");
  const snapshot = await loadSnapshot(first);
  const snapshotHash = sha(snapshot);
  if (second === "unchanged" && snapshotHash !== offered.baseSnapshotHash) throw new Error("Ipe baseline differs");
  if (second === "applied" && approval.decision !== "approved") throw new Error("Ipe approval is absent");
  if (approval.decision === "approved") {
    if (action === "recover" && await spool.read(key("consumed")) === undefined) await claim(third);
    const owner = await read("consumed", ownership);
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const active = owner.boot === boot && await processStart(owner.pid) === owner.start;
    if (owner.proposalHash !== offered.proposalHash
      || (action === "finish" && (owner.pid !== third || !active))
      || (action === "recover" && active && owner.pid !== third)) {
      throw new Error("Another Ipe process owns the outcome");
    }
    // An in-process recovery cannot invent an applied outcome; use the captured model.
  }
  await spool.publish(key("snapshot"), snapshot);
  await publish("outcome", { disposition: second, proposalHash: offered.proposalHash, snapshotHash });
  return "OK\n";
}
