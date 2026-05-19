#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchGuidelines,
  getGuideline,
  listTopics,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "greek-data-protection-mcp";
const DATA_AGE = "2026-02-11";

function responseMeta(sourceUrl?: string) {
  return {
    disclaimer:
      "For informational purposes only. Not legal or regulatory advice. Verify against official HDPA sources before relying on this information.",
    data_age: DATA_AGE,
    copyright:
      "Hellenic Data Protection Authority (HDPA / ΑΠΔΠΧ). Source: https://www.dpa.gr/",
    ...(sourceUrl !== undefined && { source_url: sourceUrl }),
  };
}

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "gr_dp_search_decisions",
    description:
      "Full-text search across HDPA decisions (sanctions, reprimands, and administrative decisions). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'Clearview AI', 'biometric data')" },
        type: {
          type: "string",
          enum: ["sanction", "reprimand", "decision", "opinion"],
          description: "Filter by decision type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_dp_get_decision",
    description:
      "Get a specific HDPA decision by reference number (e.g., 'HDPA-2022-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "HDPA decision reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "gr_dp_search_guidelines",
    description:
      "Search HDPA guidance documents: guidelines, opinions, recommendations, and circulars.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        type: {
          type: "string",
          enum: ["guideline", "opinion", "recommendation", "circular"],
          description: "Filter by guidance type. Optional.",
        },
        topic: { type: "string", description: "Filter by topic ID. Optional." },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_dp_get_guideline",
    description: "Get a specific HDPA guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Guideline database ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "gr_dp_list_topics",
    description: "List all covered data protection topics with Greek and English names.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_dp_list_sources",
    description: "List official data sources used by this MCP server.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "gr_dp_check_data_freshness",
    description: "Check when the corpus data was last updated and confirm the source URL.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["sanction", "reprimand", "decision", "opinion"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  reference: z.string().min(1),
});

const SearchGuidelinesArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["guideline", "opinion", "recommendation", "circular"]).optional(),
  topic: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidelineArgs = z.object({
  id: z.number().int().positive(),
});

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType: string = "not_found") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _meta: responseMeta(), _error_type: errorType }, null, 2),
          },
        ],
        isError: true as const,
      };
    }

    try {
      switch (name) {
        case "gr_dp_search_decisions": {
          const parsed = SearchDecisionsArgs.parse(args);
          const results = searchDecisions({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent({
            results: results.map((r) => ({
              ...r,
              _citation: buildCitation(
                (r as unknown as Record<string, unknown>).reference as string,
                (r as unknown as Record<string, unknown>).title as string,
                "gr_dp_get_decision",
                { reference: (r as unknown as Record<string, unknown>).reference as string },
              ),
            })),
            count: results.length,
            _meta: responseMeta(),
          });
        }

        case "gr_dp_get_decision": {
          const parsed = GetDecisionArgs.parse(args);
          const decision = getDecision(parsed.reference);
          if (!decision) {
            return errorContent(`Decision not found: ${parsed.reference}`);
          }
          const d = decision as unknown as Record<string, unknown>;
          return textContent({
            ...decision,
            _citation: buildCitation(
              String(d.reference ?? parsed.reference),
              String(d.title ?? d.reference ?? parsed.reference),
              "gr_dp_get_decision",
              { reference: parsed.reference },
              d.url as string | undefined,
            ),
            _meta: responseMeta(d.url as string | undefined),
          });
        }

        case "gr_dp_search_guidelines": {
          const parsed = SearchGuidelinesArgs.parse(args);
          const results = searchGuidelines({
            query: parsed.query,
            type: parsed.type,
            topic: parsed.topic,
            limit: parsed.limit,
          });
          return textContent({
            results: results.map((r) => ({
              ...r,
              _citation: buildCitation(
                ((r as unknown as Record<string, unknown>).reference ?? (r as unknown as Record<string, unknown>).title) as string,
                (r as unknown as Record<string, unknown>).title as string,
                "gr_dp_get_guideline",
                { id: String((r as unknown as Record<string, unknown>).id) },
              ),
            })),
            count: results.length,
            _meta: responseMeta(),
          });
        }

        case "gr_dp_get_guideline": {
          const parsed = GetGuidelineArgs.parse(args);
          const guideline = getGuideline(parsed.id);
          if (!guideline) {
            return errorContent(`Guideline not found: id=${parsed.id}`);
          }
          const g = guideline as unknown as Record<string, unknown>;
          return textContent({
            ...guideline,
            _citation: buildCitation(
              String(g.reference ?? g.title ?? `Guideline #${parsed.id}`),
              String(g.title ?? g.reference ?? `Guideline #${parsed.id}`),
              "gr_dp_get_guideline",
              { id: String(parsed.id) },
              g.url as string | undefined,
            ),
            _meta: responseMeta(g.url as string | undefined),
          });
        }

        case "gr_dp_list_topics": {
          const topics = listTopics();
          return textContent({ topics, count: topics.length, _meta: responseMeta() });
        }

        case "gr_dp_about": {
          return textContent({
            name: SERVER_NAME,
            version: pkgVersion,
            description:
              "HDPA (Hellenic Data Protection Authority) MCP server. Provides access to Greek data protection authority decisions, sanctions, reprimands, and official guidance documents.",
            data_source: "HDPA (https://www.dpa.gr/)",
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
            _meta: responseMeta(),
          });
        }

        case "gr_dp_list_sources": {
          return textContent({
            sources: [{ name: "HDPA", url: "https://www.dpa.gr/" }],
            _meta: responseMeta(),
          });
        }

        case "gr_dp_check_data_freshness": {
          return textContent({
            data_age: DATA_AGE,
            source: "https://www.dpa.gr/",
            _meta: responseMeta(),
          });
        }

        default:
          return errorContent(`Unknown tool: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof z.ZodError ? "validation_error" : "internal_error";
      return errorContent(`Error executing ${name}: ${message}`, errorType);
    }
  });

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      // Reentrancy guard: mcpServer.close() can synchronously re-fire
      // transport.onclose through the SDK, which would re-enter this handler
      // and recurse until the stack overflows ("RangeError: Maximum call
      // stack size exceeded" observed in prod logs). Also chain to the SDK's
      // internal _onclose wrapper (set by mcpServer.connect) to preserve its
      // cleanup of _responseHandlers, _progressHandlers, and in-flight aborts.
      const sdkOnClose = transport.onclose;
      let closing = false;
      transport.onclose = () => {
        if (closing) return;
        closing = true;
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
        sdkOnClose?.();
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
