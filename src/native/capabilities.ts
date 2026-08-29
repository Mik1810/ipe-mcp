import { constants } from "node:fs";
import { access, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { ipeDocumentCodec } from "../core/ipe-document-codec.js";
import { NATIVE_WORKER_ARTIFACT_BYTES } from "../limits.js";
import { DEFAULT_RASTER_LIMITS } from "./artifact-validation.js";
import type { ProcessLimits } from "./process.js";
import { runControlledProcess } from "./process.js";
import { openStableArtifact, type StableArtifact } from "./stable-artifact.js";

export type NativeCapabilityMode = "structural-only" | "full-7.2.30" | "nightly";
export interface NativeExecutables { readonly ipescript: string; readonly ipetoipe: string; readonly iperender: string; readonly pdflatex: string }
export interface NativeValidators { readonly pdfinfo: string; readonly pdftoppm: string; readonly mutool: string }
export interface NativeCapabilities {
  readonly mode: NativeCapabilityMode; readonly verified: boolean; readonly ipeVersion?: string; readonly xmlVersion: 70218;
  readonly features: { readonly ipelib: boolean; readonly latex: boolean; readonly pdf: boolean; readonly png: boolean; readonly svg: boolean };
  readonly toolchain: Readonly<Record<keyof NativeExecutables, { readonly path: string; readonly package: string; readonly packageVersion: string }>> | undefined;
  readonly validators: Readonly<Record<keyof NativeValidators, { readonly path: string; readonly package: string }>> | undefined;
  readonly diagnostics: readonly string[];
}
export const DEFAULT_NATIVE_EXECUTABLES: NativeExecutables = { ipescript: "/usr/bin/ipescript", ipetoipe: "/usr/bin/ipetoipe", iperender: "/usr/bin/iperender", pdflatex: "/usr/bin/pdflatex" };
export const NATIVE_VALIDATORS: NativeValidators = { pdfinfo: "/usr/bin/pdfinfo", pdftoppm: "/usr/bin/pdftoppm", mutool: "/usr/bin/mutool" };
const PROTOCOL = "ipe-mcp-native/1";
const PROBE = `<?xml version="1.0"?>\n<!DOCTYPE ipe SYSTEM "ipe.dtd">\n<ipe version="70218" creator="ipe-mcp-probe"><page><layer name="alpha"/><view layers="alpha" active="alpha"/><path layer="alpha" stroke="black">0 0 m 10 10 l</path></page></ipe>\n`;
function marker(stdout: string, name: string): string | undefined { return new RegExp(`^${name}=([A-Za-z0-9_.:/-]+)$`, "mu").exec(stdout)?.[1]; }
function helperPass(stdout: string): boolean {
  return JSON.stringify(stdout.split(/\r?\n/u).filter((line) => line.startsWith("IPE_M6_PROTOCOL=") || line.startsWith("IPE_M6_RESULT=")))
    === JSON.stringify([`IPE_M6_PROTOCOL=${PROTOCOL}`, "IPE_M6_RESULT=PASS"]);
}
async function exists(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }
async function artifactWorker(operation: string, stable: readonly StableArtifact[], helperDirectory: string, workspace: string, limits: ProcessLimitsProvider): Promise<Record<string, unknown>> {
  {
    const result = await runControlledProcess(process.execPath, [join(helperDirectory, "m6-artifact-worker.mjs"), operation, ...stable.map((item) => item.path)], workspace, limits(), "NATIVE_RENDER_ERROR", {
      IPE_M6_ARTIFACT_LIMITS: JSON.stringify({ ...DEFAULT_RASTER_LIMITS, maxArtifactBytes: NATIVE_WORKER_ARTIFACT_BYTES }),
    });
    if (!/^IPE_M6_PROTOCOL=ipe-mcp-artifact\/1$/mu.test(result.stdout) || !/^IPE_M6_RESULT=PASS$/mu.test(result.stdout)) throw new Error("artifact worker attestation failed");
    return JSON.parse(/^IPE_M6_DATA=(.+)$/mu.exec(result.stdout)?.[1] ?? "null") as Record<string, unknown>;
  }
}

async function validXml(artifact: StableArtifact, workspace: string, helperDirectory: string, limits: ProcessLimitsProvider, remaining: () => number): Promise<boolean> {
  try {
    await artifactWorker("xml", [artifact], helperDirectory, workspace, limits);
    const document = ipeDocumentCodec.parse((await artifact.read(remaining)).toString("utf8"));
    return document.format === 70218 && document.pages.length === 1 && document.pages[0]?.layers[0]?.name === "alpha"
      && document.pages[0]?.views[0]?.activeLayerId === document.pages[0]?.layers[0]?.id && document.pages[0]?.objects.length === 1;
  } catch { return false; }
}

async function validPdf(artifact: StableArtifact, workspace: string, helperDirectory: string, limits: ProcessLimitsProvider): Promise<boolean> {
  try {
    await artifactWorker("pdf", [artifact], helperDirectory, workspace, limits);
    const result = await runControlledProcess(NATIVE_VALIDATORS.pdfinfo, [artifact.path], workspace, limits(), "NATIVE_EXPORT_ERROR");
    return Number(/^Pages:\s+(\d+)$/mu.exec(result.stdout)?.[1]) === 1;
  } catch { return false; }
}

async function validRaster(artifact: StableArtifact, workspace: string, helperDirectory: string, limits: ProcessLimitsProvider, remaining: () => number, name: string): Promise<boolean> {
  try {
    const checked = join(workspace, `${name}-checked.png`);
    const processLimits = limits();
    await runControlledProcess(NATIVE_VALIDATORS.mutool, ["draw", "-q", "-F", "png", "-r", "72", "-w", String(DEFAULT_RASTER_LIMITS.maxWidth), "-h", String(DEFAULT_RASTER_LIMITS.maxHeight), "-m", String(processLimits.maxMemoryBytes), "-o", checked, artifact.path], workspace, processLimits, "NATIVE_RENDER_ERROR");
    const checkedSnapshot = await openStableArtifact(checked, workspace, 4 * 1024 * 1024, remaining);
    try { await artifactWorker("png", [checkedSnapshot], helperDirectory, workspace, limits); }
    finally { await checkedSnapshot.close(); }
    return true;
  } catch { return false; }
}

async function validPng(artifact: StableArtifact, workspace: string, helperDirectory: string, limits: ProcessLimitsProvider, remaining: () => number): Promise<boolean> {
  try { await artifactWorker("png-header", [artifact], helperDirectory, workspace, limits); return await validRaster(artifact, workspace, helperDirectory, limits, remaining, "png"); }
  catch { return false; }
}

async function validSvg(artifact: StableArtifact, workspace: string, helperDirectory: string, limits: ProcessLimitsProvider, remaining: () => number): Promise<boolean> {
  try { await artifactWorker("svg", [artifact], helperDirectory, workspace, limits); return await validRaster(artifact, workspace, helperDirectory, limits, remaining, "svg"); }
  catch { return false; }
}

async function withStable<Result>(path: string, workspace: string, remaining: () => number, operation: (artifact: StableArtifact) => Promise<Result>): Promise<Result> {
  const artifact = await openStableArtifact(path, workspace, 4 * 1024 * 1024, remaining);
  try { return await operation(artifact); }
  finally { await artifact.close(); }
}

async function verifiedValidators(workspace: string, limits: ProcessLimitsProvider): Promise<NativeCapabilities["validators"]> {
  if (process.platform !== "linux") throw new Error("native validator provenance currently requires Linux package metadata");
  await Promise.all(Object.entries(NATIVE_VALIDATORS).map(async ([name, path]) => {
    const resolved = await realpath(path);
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const magic = Buffer.alloc(4);
      if ((await handle.read(magic, 0, magic.length, 0)).bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`${name} does not resolve to an ELF executable`);
    } finally { await handle.close(); }
  }));
  const probe = await runControlledProcess("/usr/bin/dpkg-query", ["-S", ...Object.values(NATIVE_VALIDATORS)], workspace, limits(), "NATIVE_UNAVAILABLE");
  const owners = new Map(probe.stdout.trim().split("\n").map((line) => {
    const match = /^([^:]+)(?::[^:]+)?: (\/.+)$/u.exec(line);
    if (!match) throw new Error("invalid validator ownership output");
    return [match[2]!, match[1]!] as const;
  }));
  if (owners.get(NATIVE_VALIDATORS.pdfinfo) !== "poppler-utils" || owners.get(NATIVE_VALIDATORS.pdftoppm) !== "poppler-utils" || owners.get(NATIVE_VALIDATORS.mutool) !== "mupdf-tools") {
    throw new Error("validators are not owned by poppler-utils and mupdf-tools");
  }
  return Object.fromEntries(Object.entries(NATIVE_VALIDATORS).map(([name, path]) => [name, { path, package: owners.get(path)! }])) as NonNullable<NativeCapabilities["validators"]>;
}

type ProcessLimitsProvider = () => ProcessLimits;

function upstreamVersion(packageVersion: string): string | undefined {
  return /^(?:\d+:)?(7\.[23]\.\d+)(?:[-+~]|$)/u.exec(packageVersion)?.[1];
}

export function classifyNativeRelease(runtimeVersion: string, toolchain: NonNullable<NativeCapabilities["toolchain"]>): Exclude<NativeCapabilityMode, "structural-only"> {
  const tools = [toolchain.ipescript, toolchain.ipetoipe, toolchain.iperender];
  if (tools.some((tool) => tool.package !== "ipe")) throw new Error("Ipe tools are not all owned by the ipe package");
  if (new Set(tools.map((tool) => tool.packageVersion)).size !== 1) throw new Error("Ipe converter package versions are mixed");
  const packaged = upstreamVersion(tools[0]!.packageVersion);
  if (packaged === undefined) throw new Error("Ipe package version is unknown or unsupported");
  if (runtimeVersion !== packaged) throw new Error(`Ipelib runtime ${runtimeVersion} does not match converter package ${packaged}`);
  if (runtimeVersion === "7.2.30") return "full-7.2.30";
  if (/^7\.3\.\d+$/u.test(runtimeVersion)) return "nightly";
  throw new Error(`Ipe runtime ${runtimeVersion} is unknown or unsupported`);
}

async function verifiedLinuxToolchain(executables: NativeExecutables, workspace: string, limits: ProcessLimitsProvider): Promise<NativeCapabilities["toolchain"]> {
  if (process.platform !== "linux") throw new Error("verified native provenance currently requires Linux package metadata");
  const entries = await Promise.all(Object.entries(executables).map(async ([name, configured]) => {
    if (!isAbsolute(configured)) throw new Error(`${name} path is not absolute`);
    const resolved = await realpath(configured);
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(4);
      if ((await handle.read(magic, 0, magic.length, 0)).bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error(`${name} does not resolve to an ELF executable`);
    } finally { await handle.close(); }
    return [name as keyof NativeExecutables, configured, resolved] as const;
  }));
  const ownerProbe = await runControlledProcess("/usr/bin/dpkg-query", ["-S", ...entries.map(([, configured]) => configured)], workspace, limits(), "NATIVE_UNAVAILABLE");
  const owners = new Map(ownerProbe.stdout.trim().split("\n").map((line) => {
    const match = /^([^:]+)(?::[^:]+)?: (\/.+)$/u.exec(line);
    if (!match) throw new Error("invalid dpkg ownership output");
    return [match[2]!, match[1]!] as const;
  }));
  const packages = entries.map(([, configured]) => owners.get(configured)).filter((value): value is string => value !== undefined);
  if (packages.length !== entries.length) throw new Error("one or more configured tools have no package owner");
  const versionProbe = await runControlledProcess("/usr/bin/dpkg-query", ["-W", "-f=${Package}\\t${Version}\\n", ...[...new Set(packages)]], workspace, limits(), "NATIVE_UNAVAILABLE");
  const versions = new Map(versionProbe.stdout.trim().split("\n").map((line) => {
    const [name, version, extra] = line.split("\t");
    if (!name || !version || extra !== undefined) throw new Error("invalid dpkg version output");
    return [name, version] as const;
  }));
  const result = Object.fromEntries(entries.map(([name, configured, resolved]) => {
    const packageName = owners.get(configured)!;
    const packageVersion = versions.get(packageName);
    if (!packageVersion) throw new Error(`${name} package version is unavailable`);
    return [name, { path: resolved, package: packageName, packageVersion }];
  })) as Record<keyof NativeExecutables, { path: string; package: string; packageVersion: string }>;
  const ipeTools = [result.ipescript, result.ipetoipe, result.iperender];
  if (ipeTools.some((tool) => tool.package !== "ipe") || new Set(ipeTools.map((tool) => tool.packageVersion)).size !== 1 || upstreamVersion(ipeTools[0]!.packageVersion) === undefined) {
    throw new Error("Ipe tools are mixed or not from a supported ipe 7.2/7.3 package");
  }
  if (!/^texlive-(?:latex-base|binaries)$/u.test(result.pdflatex.package)) throw new Error("pdflatex is not owned by a verified TeX Live package");
  return result;
}

export async function detectNativeCapabilities(executables: NativeExecutables, helperDirectory: string, workspace: string, limits: ProcessLimits, nextLimits: ProcessLimitsProvider = () => limits, remaining: () => number = () => limits.timeoutMs): Promise<NativeCapabilities> {
  const diagnostics: string[] = [];
  const present = Object.fromEntries(await Promise.all(Object.entries(executables).map(async ([name, path]) => [name, await exists(path)]))) as Record<keyof NativeExecutables, boolean>;
  for (const [name, available] of Object.entries(present)) if (!available) diagnostics.push(`${name} is unavailable`);
  const input = join(workspace, "capability.ipe");
  await writeFile(input, PROBE, { flag: "wx", mode: 0o600 });
  let version: string | undefined; let ipelib = false; let latex = false; let pdf = false; let png = false; let svg = false; let toolchain: NativeCapabilities["toolchain"]; let validators: NativeCapabilities["validators"];
  try { validators = await verifiedValidators(workspace, nextLimits); }
  catch (error) { diagnostics.push(`artifact validator provenance attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
  if (Object.values(present).every(Boolean)) {
    try { toolchain = await verifiedLinuxToolchain(executables, workspace, nextLimits); }
    catch (error) { diagnostics.push(`toolchain provenance attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
  }
  const helperEnv = { IPESCRIPTS: helperDirectory, PATH: `${dirname(executables.pdflatex)}:/usr/bin:/bin`, TMPDIR: workspace, TEXMFOUTPUT: workspace, openin_any: "p", openout_any: "p", shell_escape: "0" };
  if (present.ipescript) {
    try {
      const versionProbe = await runControlledProcess(executables.ipescript, ["m6-native", "version"], workspace, nextLimits(), "NATIVE_LOAD_ERROR", helperEnv);
      version = marker(versionProbe.stdout, "IPE_M6_VERSION");
      if (marker(versionProbe.stdout, "IPE_M6_PROTOCOL") !== PROTOCOL || version === undefined || version === "nil" || version === "unknown") throw new Error("invalid helper protocol/version markers");
      const reloaded = join(workspace, "capability-reload.ipe");
      const loadProbe = await runControlledProcess(executables.ipescript, ["m6-native", "reload", input, reloaded], workspace, nextLimits(), "NATIVE_LOAD_ERROR", helperEnv);
      if (!helperPass(loadProbe.stdout) || !(await withStable(reloaded, workspace, remaining, async (artifact) => await validXml(artifact, workspace, helperDirectory, nextLimits, remaining)))) throw new Error("helper reload attestation failed");
      ipelib = true;
      if (present.pdflatex) {
        if (basename(executables.pdflatex) !== "pdflatex") throw new Error("configured TeX executable must be named pdflatex for Ipelib binding");
        const texSource = join(workspace, "capability-tex.tex");
        await writeFile(texSource, "\\documentclass{article}\\begin{document}ipe-mcp\\end{document}\n", { flag: "wx", mode: 0o600 });
        await runControlledProcess(executables.pdflatex, ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-output-directory", workspace, texSource], workspace, nextLimits(), "NATIVE_TEX_ERROR");
        if (!(await withStable(join(workspace, "capability-tex.pdf"), workspace, remaining, async (artifact) => await validPdf(artifact, workspace, helperDirectory, nextLimits)))) throw new Error("configured pdflatex functional attestation failed");
        const latexOutput = join(workspace, "capability-latex.ipe");
        const latexProbe = await runControlledProcess(executables.ipescript, ["m6-native", "run-latex", input, latexOutput], workspace, nextLimits(), "NATIVE_TEX_ERROR", helperEnv);
        latex = helperPass(latexProbe.stdout) && await withStable(latexOutput, workspace, remaining, async (artifact) => await validXml(artifact, workspace, helperDirectory, nextLimits, remaining));
        if (!latex) throw new Error("helper LaTeX attestation failed");
      }
    } catch (error) { diagnostics.push(`Ipe/helper attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); ipelib = false; latex = false; }
  }
  if (present.ipetoipe) {
    try {
      const output = join(workspace, "capability.pdf");
      await runControlledProcess(executables.ipetoipe, ["-pdf", "-nozip", input, output], workspace, nextLimits(), "NATIVE_EXPORT_ERROR", helperEnv);
      const recovered = join(workspace, "capability-from-pdf.ipe");
      pdf = await withStable(output, workspace, remaining, async (artifact) => {
        if (!(await validPdf(artifact, workspace, helperDirectory, nextLimits))) return false;
        await runControlledProcess(executables.ipetoipe, ["-xml", artifact.path, recovered], workspace, nextLimits(), "NATIVE_EXPORT_ERROR", helperEnv);
        return await withStable(recovered, workspace, remaining, async (recoveredArtifact) => await validXml(recoveredArtifact, workspace, helperDirectory, nextLimits, remaining));
      });
      if (!pdf) throw new Error("configured ipetoipe PDF could not be round-tripped to the expected Ipe document");
    }
    catch (error) { diagnostics.push(`ipetoipe attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
  }
  if (present.iperender) {
    for (const format of ["png", "svg"] as const) {
      try { const output = join(workspace, `capability.${format}`); await runControlledProcess(executables.iperender, [`-${format}`, "-page", "1", "-view", "1", input, output], workspace, nextLimits(), "NATIVE_RENDER_ERROR"); const valid = await withStable(output, workspace, remaining, async (artifact) => format === "png" ? await validPng(artifact, workspace, helperDirectory, nextLimits, remaining) : await validSvg(artifact, workspace, helperDirectory, nextLimits, remaining)); if (!valid) throw new Error(`configured iperender produced no valid ${format}`); if (format === "png") png = true; else svg = true; }
      catch (error) { diagnostics.push(`iperender ${format} attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
    }
  }
  const complete = ipelib && latex && pdf && png && svg && version !== undefined && toolchain !== undefined && validators !== undefined;
  let mode: NativeCapabilityMode = "structural-only";
  if (complete) {
    try { mode = classifyNativeRelease(version!, toolchain!); }
    catch (error) { diagnostics.push(`Ipe release attestation failed: ${error instanceof Error ? error.message : "unknown failure"}`); }
  }
  if (complete && mode === "nightly") diagnostics.push(`native Ipe ${version} is not the verified 7.2.30 baseline`);
  return { mode, verified: complete && mode !== "structural-only", ...(version ? { ipeVersion: version } : {}), xmlVersion: 70218, features: { ipelib, latex, pdf, png, svg }, toolchain, validators, diagnostics };
}
