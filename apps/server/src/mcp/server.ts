/**
 * MCP 端点（M1–M3）：规范 Streamable HTTP，协议版本与 Sqraft 桌面端一致（2025-11-25 / 2025-06-18 / 2025-03-26）。
 *
 * - `POST /mcp`：JSON-RPC；`initialize` 时下发 `Mcp-Session-Id`，之后每个请求都要带；会话绑定到令牌；
 * - `DELETE /mcp`：结束会话；`GET /mcp`：不提供 SSE 流，返回 405（规范允许）；
 * - 只认 `Authorization: Bearer` 令牌（mcp 或 uploader 用途，都只能用只读工具）；拒绝跨站 `Origin`；
 * - 每个令牌默认 60 次 / 分钟；每次工具调用记审计日志（谁、哪个令牌、读了哪个设计稿）。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { audit } from "../audit";
import type { Principal } from "../auth";
import { generateSecret } from "../crypto";
import { HttpError } from "../errors";
import type { DesignReader } from "../reader";
import { APP_VERSION } from "../routes/system";
import { McpTools, TOOLS } from "./tools";

export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST = SUPPORTED_PROTOCOLS[0];
const SESSION_HEADER = "mcp-session-id";
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface Session {
  tokenId: string;
  protocol: string;
  lastSeen: number;
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function mcpRoutes(app: FastifyInstance, ctx: AppContext, reader: DesignReader): void {
  const sessions = new Map<string, Session>();
  const calls = new Map<string, number[]>();
  const tools = new McpTools(ctx, reader);
  const ratePerMinute = ctx.config.mcpRatePerMinute;

  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) sessions.delete(id);
  };

  const authenticate = (req: FastifyRequest, reply: FastifyReply): Principal | null => {
    const origin = req.headers.origin;
    if (origin) {
      const allowed = ctx.config.publicUrl ? new URL(ctx.config.publicUrl).origin : null;
      if (origin !== allowed) {
        reply.status(403).send(rpcError(null, -32600, "不接受浏览器跨站请求"));
        return null;
      }
    }
    const p = req.principal;
    if (!p || p.via !== "token" || !p.token) {
      reply
        .status(401)
        .header("WWW-Authenticate", 'Bearer realm="sqraft-cloud"')
        .send(rpcError(null, -32001, "需要令牌：在网页「MCP 接入」页创建后用 Authorization: Bearer 传入"));
      return null;
    }
    if (p.user.must_change_password === 1) {
      reply.status(403).send(rpcError(null, -32001, "账号需要先在网页上修改初始密码"));
      return null;
    }
    return p;
  };

  const limit = (tokenId: string) => {
    const now = Date.now();
    const recent = (calls.get(tokenId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= ratePerMinute) {
      throw new HttpError(429, "rate_limited", `调用过于频繁：每个令牌每分钟最多 ${ratePerMinute} 次`, {
        retryAfter: Math.ceil((60_000 - (now - recent[0])) / 1000),
      });
    }
    recent.push(now);
    calls.set(tokenId, recent);
  };

  const baseUrl = (req: FastifyRequest) => ctx.config.publicUrl ?? `${req.protocol}://${req.headers.host ?? "localhost"}`;

  app.get("/mcp", async (_req, reply) => reply.status(405).header("Allow", "POST, DELETE").send());

  app.delete("/mcp", async (req, reply) => {
    const p = authenticate(req, reply);
    if (!p) return reply;
    const sid = req.headers[SESSION_HEADER];
    if (typeof sid === "string" && sessions.get(sid)?.tokenId === p.token!.id) sessions.delete(sid);
    return reply.status(204).send();
  });

  app.post<{ Body: unknown }>("/mcp", async (req, reply) => {
    const p = authenticate(req, reply);
    if (!p) return reply;
    sweep();
    const msg = req.body as RpcRequest;
    if (Array.isArray(req.body) || !msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return reply.status(400).send(rpcError(null, -32600, "不是有效的 JSON-RPC 2.0 请求（不支持批量）"));
    }
    const isNotification = msg.id === undefined;

    if (msg.method === "initialize") {
      const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocol = SUPPORTED_PROTOCOLS.includes(requested as never) ? (requested as string) : LATEST;
      const sid = generateSecret();
      sessions.set(sid, { tokenId: p.token!.id, protocol, lastSeen: Date.now() });
      reply.header("Mcp-Session-Id", sid);
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          protocolVersion: protocol,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sqraft-cloud", version: APP_VERSION },
          instructions:
            "Sqraft 私有云的只读设计稿。按 list_designs → list_pages → read_page / inspect_layout 逐层读取；" +
            "切图用 get_asset 拿下载链接；样式里的 Token 用 get_tokens 解析。所有工具都只读。",
        },
      };
    }

    const sid = req.headers[SESSION_HEADER];
    if (typeof sid !== "string") return reply.status(400).send(rpcError(msg.id, -32600, "缺少 Mcp-Session-Id，请先 initialize"));
    const session = sessions.get(sid);
    if (!session || session.tokenId !== p.token!.id) {
      return reply.status(404).send(rpcError(msg.id, -32001, "会话不存在或已过期，请重新 initialize"));
    }
    session.lastSeen = Date.now();

    if (isNotification) return reply.status(202).send();

    switch (msg.method) {
      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
      case "tools/call": {
        const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
        const name = typeof params?.name === "string" ? params.name : "";
        if (!name) return rpcError(msg.id, -32602, "tools/call 缺少工具名");
        const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        if (!TOOLS.some((t) => t.name === name)) {
          audit(ctx.db, p, req.ip, { action: "mcp.call", target: null, result: "denied", detail: { tool: name } });
          return rpcError(msg.id, -32602, `没有这个工具：${name}（私有云只提供只读工具）`);
        }
        limit(p.token!.id);
        try {
          const [result, designId] = await tools.call(name, args, p, baseUrl(req));
          audit(ctx.db, p, req.ip, { action: "mcp.call", target: designId, detail: { tool: name } });
          return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          audit(ctx.db, p, req.ip, { action: "mcp.call", target: typeof args.designId === "string" ? args.designId : null, result: "failed", detail: { tool: name, error: message } });
          return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: message }], isError: true } };
        }
      }
      default:
        return rpcError(msg.id, -32601, `不支持的方法：${msg.method}`);
    }
  });
}
