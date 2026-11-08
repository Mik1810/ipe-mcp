import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { requestLifetime, withRequestLifetime } from "../../runtime/request-lifetime.js";
import { safeLog } from "../errors.js";
import { createMcpServer } from "../server.js";
import type { IpeMcpService } from "../service.js";
import { matchesCredential } from "./profile.js";
import { checkProtocol, HttpRejection, rpcRejection, scrubProtocolError } from "./protocol.js";

const host = "127.0.0.1";
const route = "/mcp";
const maxBodyBytes = 16 * 1024 * 1024;
const bodyDeadlineMs = 10_000;
const maxExchanges = 8;
const burst = 16;
const ratePerMs = 60 / 1000;
const forwarded = /^(?:forwarded$|x-forwarded-|x-real-ip$|proxy-)/u;
const sdkHeaders = ["accept", "content-type", "mcp-protocol-version", "mcp-method", "mcp-name"];
const singletonHeaders = ["authorization", "content-type", "content-encoding", "content-length", "transfer-encoding", ...sdkHeaders.slice(2)];

function rawHeaders(request: IncomingMessage): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const key = request.rawHeaders[i]!.toLowerCase();
    const values = result.get(key) ?? [];
    values.push(request.rawHeaders[i + 1]!);
    result.set(key, values);
  }
  return result;
}

function admit(request: IncomingMessage, authority: string, credential: Buffer): Headers {
  const headers = rawHeaders(request);
  const hosts = headers.get("host");
  if (request.socket.remoteAddress !== host || hosts?.length !== 1 || hosts[0] !== authority || headers.has("origin") || [...headers.keys()].some((key) => forwarded.test(key))) {
    throw new HttpRejection(403);
  }
  if (request.url !== route) throw new HttpRejection(404);
  const auth = headers.get("authorization");
  if (auth?.length !== 1 || !matchesCredential(auth[0], credential)) throw new HttpRejection(401);
  if (request.method !== "POST") throw new HttpRejection(405);
  if (headers.has("expect")) throw new HttpRejection(417);
  if (singletonHeaders.some((key) => (headers.get(key)?.length ?? 0) > 1) || headers.has("mcp-session-id") || headers.has("last-event-id")) throw new HttpRejection(400);
  if (headers.has("content-encoding") || !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/iu.test(headers.get("content-type")?.[0] ?? "")) {
    throw new HttpRejection(415);
  }
  const length = headers.get("content-length")?.[0];
  if (length !== undefined && Number(length) > maxBodyBytes) throw new HttpRejection(413);
  return new Headers(sdkHeaders.flatMap((key) => (headers.get(key) ?? []).map((value) => [key, value])));
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      request.off("data", data).off("end", end).off("error", finish);
      if (error !== undefined) { request.pause(); reject(error); return; }
      try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { reject(new HttpRejection(400, -32700)); }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) finish(new HttpRejection(413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const abort = () => finish(new HttpRejection(408));
    const timer = setTimeout(abort, bodyDeadlineMs);
    signal.addEventListener("abort", abort, { once: true });
    request.on("data", data).once("end", end).once("error", finish);
    if (signal.aborted) abort();
  });
  try { return JSON.parse(text) as unknown; }
  catch { throw new HttpRejection(400, -32700); }
}

function reject(response: ServerResponse, status: number, rpcCode?: number, requestId: number | string | null = null): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  response.statusCode = status;
  response.setHeader("Connection", "close");
  response.setHeader("Cache-Control", "no-store");
  if (status === 401) response.setHeader("WWW-Authenticate", "Bearer");
  if (status === 405) response.setHeader("Allow", "POST");
  if (rpcCode !== undefined) response.setHeader("Content-Type", "application/json");
  response.end(rpcCode === undefined ? undefined : rpcRejection(rpcCode, requestId));
}

interface ListenerOptions {
  readonly port: number;
  readonly credential: Buffer;
  readonly deadlineMs: number;
}

export async function listenHttp(service: IpeMcpService, { port, credential, deadlineMs }: ListenerOptions) {
  const handler = createMcpHandler(() => createMcpServer(service), { legacy: "stateless", onerror: () => safeLog("http_protocol_rejected") });
  const active = new Map<AbortController, Promise<void>>();
  const responding = new Map<Duplex, number>();
  let closing: Promise<void> | undefined;
  let authority: string;
  let tokens = burst;
  let last = performance.now();

  const exchange = async (request: IncomingMessage, response: ServerResponse, controller: AbortController) => {
    const { signal } = controller;
    const scope = requestLifetime(signal);
    const abort = () => { if (!response.writableFinished) controller.abort(); };
    const timer = setTimeout(() => {
      reject(response, 504);
      controller.abort();
    }, deadlineMs);
    response.once("close", abort);
    // An early HTTP rejection may precede a request stream error.
    request.on("error", abort);
    try {
      const headers = admit(request, authority, credential);
      const body = await readBody(request, signal);
      const webRequest = new Request("http://" + authority + route, { method: "POST", headers, signal });
      await checkProtocol(webRequest, body);
      signal.throwIfAborted();
      const reply = await withRequestLifetime(scope, () => handler.fetch(webRequest, { parsedBody: body }));
      if (reply.status >= 400) {
        const { code, id } = await scrubProtocolError(reply);
        reject(response, reply.status, code, id);
      } else {
        response.statusCode = reply.status;
        response.setHeader("Cache-Control", "no-store");
        const type = reply.headers.get("content-type");
        if (type !== null) response.setHeader("Content-Type", type);
        if (reply.body === null) response.end();
        else await pipeline(Readable.fromWeb(reply.body as ReadableStream<Uint8Array>), response, { signal });
      }
    } catch (error) {
      if (error instanceof HttpRejection) reject(response, error.status, error.rpcCode, error.requestId);
      else if (!signal.aborted) reject(response, 500);
    } finally {
      clearTimeout(timer);
      response.off("close", abort);
      // SDK exchange cancellation can precede completion of an atomic write.
      await Promise.allSettled(scope.work);
      safeLog("http_exchange", { status: response.statusCode });
    }
  };

  const accept = (request: IncomingMessage, response: ServerResponse) => {
    const socket = request.socket;
    responding.set(socket, (responding.get(socket) ?? 0) + 1);
    const finished = () => {
      response.off("finish", finished).off("close", finished);
      const remaining = (responding.get(socket) ?? 1) - 1;
      if (remaining === 0) responding.delete(socket);
      else responding.set(socket, remaining);
    };
    response.once("finish", finished).once("close", finished);
    if (closing !== undefined) { reject(response, 503); return; }
    const now = performance.now();
    tokens = Math.min(burst, tokens + (now - last) * ratePerMs);
    last = now;
    if (tokens < 1 || active.size >= maxExchanges) { reject(response, 429); return; }
    tokens -= 1;
    const controller = new AbortController();
    const done = exchange(request, response, controller).finally(() => { active.delete(controller); });
    active.set(controller, done);
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 5000, requestTimeout: bodyDeadlineMs, connectionsCheckingInterval: 1000 }, accept);
  server.maxConnections = 32;
  server.on("checkContinue", accept).on("checkExpectation", accept);
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (socket.writable && !responding.has(socket)) {
      const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large"
        : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
      socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n");
    } else socket.destroy();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unexpected HTTP address");
  authority = host + ":" + String(address.port);

  return {
    port: address.port,
    close(): Promise<void> {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const controller of active.keys()) controller.abort();
        server.closeAllConnections();
        await handler.close();
        await Promise.allSettled(active.values());
        await closed;
      })();
      return closing;
    },
  };
}
