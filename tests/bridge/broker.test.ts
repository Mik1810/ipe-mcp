import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeBroker } from "../../src/bridge/broker.js";
import { BridgeSpool } from "../../src/bridge/spool.js";
import { ipeDocumentCodec } from "../../src/core/ipe-document-codec.js";
import { IpeMcpService } from "../../src/mcp/service.js";

describe.skipIf(process.platform !== "linux")("bridge broker and revisioned Ipe service", () => {
  let root: string;
  let workspace: string;
  let source: string;
  let state: string;
  let spool: BridgeSpool;
  let service: IpeMcpService;
  const post = (epoch: string, sequence: number, xml: string) => spool.publish({ epoch, sequence, kind: "snapshot" }, Buffer.from(xml));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ipe-bridge-broker-"));
    workspace = join(root, "workspace");
    source = join(workspace, "source.ipe");
    state = join(workspace, "state");
    const handoff = join(root, "handoff");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(handoff, { mode: 0o700 });
    await copyFile("fixtures/conformance/m6/full.xml", source);
    service = await IpeMcpService.create([workspace], state);
    spool = await BridgeSpool.open(handoff, [workspace]);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("attaches to a native snapshot, preserves stable identities, and replays its receipt after restart", async () => {
    const original = await readFile(source);
    const opened = await service.sessions.open(source);
    const broker = new BridgeBroker(service.sessions, spool);
    const { epoch } = await broker.invite(opened.documentId, 0);
    const gui = await service.native.reload(opened.document);
    await post(epoch, 0, gui.source);
    expect((await broker.attach(epoch)).revision).toBe(0);

    const edited = gui.source.replace("M6 fixture", "Ipe bridge edit").replace("290 150 l", "275 150 l");
    expect(edited).not.toBe(gui.source);
    const snapshotHash = await post(epoch, 1, edited);
    const result = await broker.ingest(epoch, 1);
    expect(result).toEqual({ revision: 1, snapshotHash });
    const changed = service.sessions.inspect(opened.documentId).document;
    expect(changed.metadata?.title).toBe("Ipe bridge edit");
    expect(changed.pages[0]?.id).toBe(opened.document.pages[0]?.id);
    expect(changed.pages[0]?.objects.map(({ id }) => id)).toEqual(opened.document.pages[0]?.objects.map(({ id }) => id));
    expect(changed.pages[0]?.views.map(({ id }) => id)).toEqual(opened.document.pages[0]?.views.map(({ id }) => id));
    expect(changed.pages[0]?.layers.map(({ id }) => id)).toEqual(opened.document.pages[0]?.layers.map(({ id }) => id));
    expect(ipeDocumentCodec.serialize(changed)).toContain("275 150 l");
    expect((await service.validate(opened.documentId, "full")).ok).toBe(true);
    expect(await readFile(source)).toEqual(original);

    const restarted = await IpeMcpService.create([workspace], state);
    await restarted.recover();
    expect(await new BridgeBroker(restarted.sessions, spool).ingest(epoch, 1)).toEqual(result);
    expect(restarted.sessions.inspect(opened.documentId).revision).toBe(1);
  });

  it("rejects a different initial snapshot, out-of-order delivery and a concurrent MCP revision", async () => {
    const opened = await service.sessions.open(source);
    const broker = new BridgeBroker(service.sessions, spool);
    const gui = (await service.native.reload(opened.document)).source;
    const divergent = (await broker.invite(opened.documentId, 0)).epoch;
    await post(divergent, 0, gui.replace("M6 fixture", "Different open document"));
    await expect(broker.attach(divergent)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });

    const { epoch } = await broker.invite(opened.documentId, 0);
    await post(epoch, 0, gui);
    await broker.attach(epoch);
    await post(epoch, 2, gui);
    await expect(broker.ingest(epoch, 2)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });
    await service.sessions.mutate(opened.documentId, 0, (document) => { document.metadata = { ...document.metadata, title: "MCP edit" }; });
    await post(epoch, 1, gui);
    await expect(broker.ingest(epoch, 1)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(service.sessions.inspect(opened.documentId).document.metadata?.title).toBe("MCP edit");
  });

  it("publishes an immutable MCP proposal tied to the prior snapshot without authorizing a GUI write", async () => {
    const original = await readFile(source);
    const opened = await service.sessions.open(source);
    const broker = new BridgeBroker(service.sessions, spool);
    const { epoch } = await broker.invite(opened.documentId, 0);
    const gui = (await service.native.reload(opened.document)).source;
    await post(epoch, 0, gui);
    const attached = await broker.attach(epoch);
    await service.sessions.mutate(opened.documentId, 0, (document) => { document.metadata = { ...document.metadata, title: "MCP proposal" }; });
    const offered = await broker.offer(epoch, 1, 1);
    expect(offered).toMatchObject({ baseRevision: 0, targetRevision: 1, baseSnapshotHash: attached.snapshotHash });
    const proposal = await spool.read({ epoch, sequence: 1, kind: "proposal" });
    expect(proposal?.sha256).toBe(offered.proposalHash);
    expect(ipeDocumentCodec.parse(proposal!.bytes).metadata?.title).toBe("MCP proposal");
    expect(await broker.offer(epoch, 1, 1)).toEqual(offered);
    expect(await spool.read({ epoch, sequence: 1, kind: "receipt" })).toBeUndefined();
    await post(epoch, 1, gui);
    await expect(broker.ingest(epoch, 1)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });
    expect(await readFile(source)).toEqual(original);
  });


  it("rejects a duplicated persistent object carrier without applying the snapshot", async () => {
    const opened = await service.sessions.open(source);
    const broker = new BridgeBroker(service.sessions, spool);
    const { epoch } = await broker.invite(opened.documentId, 0);
    const gui = (await service.native.reload(opened.document)).source;
    await post(epoch, 0, gui);
    await broker.attach(epoch);
    const page = gui.slice(gui.indexOf("<page"));
    const object = /<path\b[^>]*\bcustom="[^"]+"[^>]*>[^<]+<\/path>/u.exec(page)?.[0];
    expect(object).toBeDefined();
    await post(epoch, 1, gui.replace("</page>", object! + "\n</page>"));
    await expect(broker.ingest(epoch, 1)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });
    expect(service.sessions.inspect(opened.documentId).revision).toBe(0);
  });


  it("requires a GUI decision, reserves the revision across restart, and only releases on a verified outcome", async () => {
    const opened = await service.sessions.open(source);
    const broker = new BridgeBroker(service.sessions, spool);
    const { epoch } = await broker.invite(opened.documentId, 0);
    const gui = (await service.native.reload(opened.document)).source;
    await post(epoch, 0, gui);
    await broker.attach(epoch);
    await service.sessions.mutate(opened.documentId, 0, (document) => { document.metadata = { ...document.metadata, title: "Approved proposal" }; });
    const offer = await broker.offer(epoch, 1, 1);
    const write = (kind: "approval" | "consumed" | "outcome", value: object) =>
      spool.publish({ epoch, sequence: 1, kind }, Buffer.from(JSON.stringify(value)));
    await expect(broker.authorize(epoch, 1)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });
    await write("approval", { decision: "approved", baseSnapshotHash: offer.baseSnapshotHash, proposalHash: offer.proposalHash });
    expect(await broker.authorize(epoch, 1)).toEqual({ targetRevision: 1 });
    await expect(service.sessions.mutate(opened.documentId, 1, () => undefined)).rejects.toMatchObject({ code: "BRIDGE_REVIEW_PENDING" });

    const restarted = await IpeMcpService.create([workspace], state);
    await restarted.recover();
    const recovered = new BridgeBroker(restarted.sessions, spool);
    await expect(restarted.sessions.save(opened.documentId, 1, join(workspace, "blocked.ipe"))).rejects.toMatchObject({ code: "BRIDGE_REVIEW_PENDING" });
    expect(await recovered.authorize(epoch, 1)).toEqual({ targetRevision: 1 });
    const proposal = await spool.read({ epoch, sequence: 1, kind: "proposal" });
    const snapshot = (await restarted.native.reload(ipeDocumentCodec.parse(proposal!.bytes))).source;
    const snapshotHash = await post(epoch, 1, snapshot);
    await write("outcome", { disposition: "applied", proposalHash: offer.proposalHash, snapshotHash });
    await expect(recovered.settle(epoch, 1)).rejects.toMatchObject({ code: "BRIDGE_CONFLICT" });
    await write("consumed", { proposalHash: offer.proposalHash });
    expect(await recovered.settle(epoch, 1)).toEqual({ revision: 1, snapshotHash });
    expect(await recovered.settle(epoch, 1)).toEqual({ revision: 1, snapshotHash });
    await expect(recovered.authorize(epoch, 1)).rejects.toThrow(/already settled/u);
    expect((await restarted.sessions.mutate(opened.documentId, 1, () => undefined)).revision).toBe(2);
  });

});
