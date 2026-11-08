import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { ipeDocumentCodec, type IpeDocument } from "../core/ipe-document-codec.js";
import type { BridgeCommit, BridgeGrant, DocumentSessionManager } from "../persistence/session-manager.js";
import { BridgeConflictError, checkInitialBridgeSnapshot, parseBridgeSnapshot, reconcileBridgeSnapshot } from "./snapshot.js";
import { BridgeSpool } from "./spool.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const invitationSchema = z.object({ documentId: z.uuid(), revision, sourceStamp: digest }).strict();
const receiptSchema = z.object({ revision, snapshotHash: digest }).strict();
const offerSchema = z.object({
  baseRevision: revision, targetRevision: revision, baseSnapshotHash: digest, proposalHash: digest,
}).strict();
const approvalSchema = z.object({
  proposalHash: digest, baseSnapshotHash: digest, decision: z.enum(["approved", "declined"]),
}).strict();
const outcomeSchema = z.object({
  proposalHash: digest, snapshotHash: digest, disposition: z.enum(["applied", "unchanged"]),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
type Offer = z.infer<typeof offerSchema>;

function decode<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
}

function requireSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0x7fff_ffff) throw new Error("Invalid bridge sequence");
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** Pull-based broker for one live service. GUI snapshots arrive through the private spool. */
export class BridgeBroker {
  constructor(private readonly sessions: DocumentSessionManager<IpeDocument>, private readonly spool: BridgeSpool) {}

  async invite(documentId: string, expectedRevision: number): Promise<{ readonly epoch: string }> {
    const sourceStamp = await this.sessions.bridgeSourceStamp(documentId, expectedRevision);
    const epoch = randomBytes(16).toString("hex");
    await this.spool.publish({ epoch, sequence: 0, kind: "attachment" }, encode({ documentId, revision: expectedRevision, sourceStamp }));
    return { epoch };
  }

  async attach(epoch: string): Promise<Receipt> {
    const invitation = await this.#invitation(epoch);
    const snapshot = await this.#snapshot(epoch, 0);
    const existing = await this.#receipt(epoch, 0);
    if (existing !== undefined) return this.#sameSnapshot(existing, snapshot.sha256);
    const base = this.sessions.inspect(invitation.documentId);
    checkInitialBridgeSnapshot(base.document, parseBridgeSnapshot(snapshot.bytes));
    if (await this.sessions.bridgeSourceStamp(invitation.documentId, invitation.revision) !== invitation.sourceStamp) {
      throw new BridgeConflictError("source changed before attach");
    }
    return await this.#publishReceipt(epoch, 0, { revision: invitation.revision, snapshotHash: snapshot.sha256 });
  }

  async ingest(epoch: string, sequence: number): Promise<Receipt> {
    requireSequence(sequence);
    const invitation = await this.#invitation(epoch);
    const snapshot = await this.#snapshot(epoch, sequence);
    const existing = await this.#receipt(epoch, sequence);
    if (existing !== undefined) return this.#sameSnapshot(existing, snapshot.sha256);
    const previous = await this.#receipt(epoch, sequence - 1);
    if (previous === undefined) throw new BridgeConflictError("previous bridge receipt is absent");
    const baseline = await this.#snapshot(epoch, sequence - 1);
    this.#sameSnapshot(previous, baseline.sha256);
    await this.#claim(epoch, sequence, "gui", snapshot.sha256);
    const result = await this.sessions.commitBridgeSnapshot(invitation.documentId, previous.revision,
      { epoch, sequence, snapshotHash: snapshot.sha256, sourceStamp: invitation.sourceStamp },
      (base) => reconcileBridgeSnapshot(base, parseBridgeSnapshot(baseline.bytes), parseBridgeSnapshot(snapshot.bytes)),
      async (commit: BridgeCommit) => {
        const receipt = await this.#receipt(commit.epoch, commit.sequence);
        return receipt?.snapshotHash === commit.snapshotHash && receipt.revision === commit.revision;
      });
    return await this.#publishReceipt(epoch, sequence, { revision: result.revision, snapshotHash: snapshot.sha256 });
  }

  /** Stage a private proposal. Publication does not grant authority to write into Ipe. */
  async offer(epoch: string, sequence: number, expectedRevision: number): Promise<Offer> {
    requireSequence(sequence);
    const invitation = await this.#invitation(epoch);
    const prior = await this.#receipt(epoch, sequence - 1);
    if (prior === undefined || expectedRevision <= prior.revision) throw new BridgeConflictError("proposal revision");
    const baseline = await this.#snapshot(epoch, sequence - 1);
    this.#sameSnapshot(prior, baseline.sha256);
    const current = this.sessions.inspect(invitation.documentId);
    if (await this.sessions.bridgeSourceStamp(invitation.documentId, expectedRevision) !== invitation.sourceStamp
      || current.revision !== expectedRevision) throw new BridgeConflictError("proposal source or revision changed");
    const proposal = Buffer.from(ipeDocumentCodec.serialize(current.document));
    parseBridgeSnapshot(proposal);
    const proposalHash = createHash("sha256").update(proposal).digest("hex");
    await this.#claim(epoch, sequence, "mcp", proposalHash);
    await this.spool.publish({ epoch, sequence, kind: "proposal" }, proposal);
    // An immutable offer can only refer to a completely published proposal.
    const result = offerSchema.parse({
      baseRevision: prior.revision, targetRevision: expectedRevision, baseSnapshotHash: prior.snapshotHash, proposalHash,
    });
    await this.spool.publish({ epoch, sequence, kind: "offer" }, encode(result));
    return result;
  }

  /** A local GUI decision, both hashes, and the current revision are required. */
  async authorize(epoch: string, sequence: number): Promise<{ readonly targetRevision: number }> {
    requireSequence(sequence);
    const invitation = await this.#invitation(epoch);
    const offer = await this.#offer(epoch, sequence);
    const approval = await this.#approval(epoch, sequence, offer);
    if (approval.decision !== "approved") throw new BridgeConflictError("Ipe did not approve the proposal");
    if (await this.#receipt(epoch, sequence) !== undefined) throw new BridgeConflictError("proposal already settled");
    const grant = this.#grant(epoch, sequence, offer);
    await this.sessions.reserveBridgeGrant(invitation.documentId, grant, invitation.sourceStamp,
      async () => await this.#receipt(epoch, sequence) === undefined);
    await this.spool.publish({ epoch, sequence, kind: "grant" }, encode(grant));
    return { targetRevision: grant.revision };
  }

  async settle(epoch: string, sequence: number): Promise<Receipt> {
    requireSequence(sequence);
    const invitation = await this.#invitation(epoch);
    const offer = await this.#offer(epoch, sequence);
    const approval = await this.#approval(epoch, sequence, offer);
    const grant = this.#grant(epoch, sequence, offer);
    const snapshot = await this.#snapshot(epoch, sequence);
    const existing = await this.#receipt(epoch, sequence);
    if (existing !== undefined) {
      this.#sameSnapshot(existing, snapshot.sha256);
      await this.sessions.releaseBridgeGrant(invitation.documentId, grant);
      return existing;
    }
    const record = await this.spool.read({ epoch, sequence, kind: "outcome" });
    if (record === undefined) throw new BridgeConflictError("GUI outcome is absent");
    const outcome = decode(outcomeSchema, record.bytes);
    if (outcome.proposalHash !== offer.proposalHash || outcome.snapshotHash !== snapshot.sha256) {
      throw new BridgeConflictError("GUI outcome does not match the proposal or snapshot");
    }
    if (approval.decision === "approved") {
      const consumed = await this.spool.read({ epoch, sequence, kind: "consumed" });
      if (consumed === undefined) throw new BridgeConflictError("GUI did not consume the grant");
      await this.sessions.confirmBridgeGrant(invitation.documentId, grant);
    } else if (outcome.disposition !== "unchanged") {
      throw new BridgeConflictError("declined proposal reported a GUI write");
    }
    const unchanged = outcome.disposition === "unchanged";
    if (unchanged) {
      if (snapshot.sha256 !== offer.baseSnapshotHash) throw new BridgeConflictError("GUI baseline changed");
    } else {
      const proposal = await this.spool.read({ epoch, sequence, kind: "proposal" });
      if (proposal?.sha256 !== offer.proposalHash) throw new BridgeConflictError("proposal bytes changed");
      checkInitialBridgeSnapshot(parseBridgeSnapshot(proposal.bytes), parseBridgeSnapshot(snapshot.bytes));
    }
    const receipt = await this.#publishReceipt(epoch, sequence, {
      revision: unchanged ? offer.baseRevision : offer.targetRevision,
      snapshotHash: snapshot.sha256,
    });
    await this.sessions.releaseBridgeGrant(invitation.documentId, grant);
    return receipt;
  }

  #grant(epoch: string, sequence: number, offer: Offer): BridgeGrant {
    return { epoch, sequence, revision: offer.targetRevision, proposalHash: offer.proposalHash };
  }

  async #offer(epoch: string, sequence: number): Promise<Offer> {
    const record = await this.spool.read({ epoch, sequence, kind: "offer" });
    if (record === undefined) throw new BridgeConflictError("proposal is absent");
    return decode(offerSchema, record.bytes);
  }

  async #approval(epoch: string, sequence: number, offer: Offer) {
    const record = await this.spool.read({ epoch, sequence, kind: "approval" });
    if (record === undefined) throw new BridgeConflictError("Ipe approval is absent");
    const approval = decode(approvalSchema, record.bytes);
    if (approval.proposalHash !== offer.proposalHash || approval.baseSnapshotHash !== offer.baseSnapshotHash) {
      throw new BridgeConflictError("Ipe decision does not match the proposal");
    }
    return approval;
  }

  async #claim(epoch: string, sequence: number, direction: "gui" | "mcp", hash: string): Promise<void> {
    const key = { epoch, sequence, kind: "intent" } as const;
    const bytes = Buffer.from(encode({ direction, hash }));
    try {
      await this.spool.publish(key, bytes);
    } catch (error) {
      const existing = await this.spool.read(key);
      if (existing !== undefined && !existing.bytes.equals(bytes)) throw new BridgeConflictError("sequence already claimed");
      throw error;
    }
  }

  async #invitation(epoch: string) {
    const record = await this.spool.read({ epoch, sequence: 0, kind: "attachment" });
    if (record === undefined) throw new BridgeConflictError("unknown attachment");
    return decode(invitationSchema, record.bytes);
  }

  async #snapshot(epoch: string, sequence: number) {
    const snapshot = await this.spool.read({ epoch, sequence, kind: "snapshot" });
    if (snapshot === undefined) throw new BridgeConflictError("GUI snapshot is absent");
    return snapshot;
  }

  async #receipt(epoch: string, sequence: number): Promise<Receipt | undefined> {
    const record = await this.spool.read({ epoch, sequence, kind: "receipt" });
    return record === undefined ? undefined : decode(receiptSchema, record.bytes);
  }

  async #publishReceipt(epoch: string, sequence: number, receipt: Receipt): Promise<Receipt> {
    await this.spool.publish({ epoch, sequence, kind: "receipt" }, encode(receipt));
    return receipt;
  }

  #sameSnapshot(receipt: Receipt, sha256: string): Receipt {
    if (receipt.snapshotHash !== sha256) throw new BridgeConflictError("snapshot differs from the acknowledged bytes");
    return receipt;
  }
}
