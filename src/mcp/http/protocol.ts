import { isLegacyRequest } from "@modelcontextprotocol/server";

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
const versionKey = "io.modelcontextprotocol/protocolVersion";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class HttpRejection extends Error {
  constructor(readonly status: number, readonly rpcCode?: number, readonly requestId: number | string | null = null) {
    super("HTTP request rejected");
  }
}

function replyId(message: Record<string, unknown>): string | number | null {
  return typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
}

export async function checkProtocol(request: Request, input: unknown): Promise<void> {
  const message = record(input);
  if (message === undefined || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new HttpRejection(400, -32600);
  const version = request.headers.get("mcp-protocol-version");
  const metadata = record(record(message.params)?._meta);
  const claim = metadata?.[versionKey];
  if (await isLegacyRequest(request, input)) {
    if (request.headers.has("mcp-method") || request.headers.has("mcp-name")) throw new HttpRejection(400, -32020, replyId(message));
    const allowed = message.method === "initialize"
      ? version === null && record(message.params)?.protocolVersion === LEGACY
      : version === LEGACY;
    if (!allowed) throw new HttpRejection(400, -32022, replyId(message));
  } else if (message.method === "initialize" || (version !== null && version !== MODERN && claim === undefined)) {
    throw new HttpRejection(400, -32022, replyId(message));
  }
  if (message.method === "subscriptions/listen" || message.method === "resources/subscribe" || message.method === "resources/unsubscribe") {
    throw new HttpRejection(400, -32601, replyId(message));
  }
}

export function rpcRejection(code: number, id: number | string | null): string {
  const details = code === -32022
    ? { message: "Unsupported MCP protocol version", data: { supported: [MODERN, LEGACY], requested: "unsupported" } }
    : { message: "MCP request rejected" };
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, ...details } });
}

/** The SDK may include supplied header or metadata values in HTTP errors. */
export async function scrubProtocolError(response: Response): Promise<{ code: number; id: number | string | null }> {
  const message = record(await response.json().catch(() => undefined));
  const code = record(message?.error)?.code;
  return { code: typeof code === "number" ? code : -32600, id: message === undefined ? null : replyId(message) };
}
