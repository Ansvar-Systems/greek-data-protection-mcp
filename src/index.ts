#!/usr/bin/env node

/**
 * Greek Data Protection MCP — stdio entry point.
 *
 * Provides MCP tools for querying HDPA decisions, sanctions, and
 * data protection guidance documents.
 *
 * Tool prefix: gr_dp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

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

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "gr_dp_search_decisions",
    description:
      "Full-text search across HDPA decisions (sanctions, reprimands, and administrative decisions). Returns matching decisions with reference, entity name, fine amount, and GDPR articles cited.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'Clearview AI', 'biometric data', 'consent cookies')",
        },
        type: {
          type: "string",
          enum: ["sanction", "reprimand", "decision", "opinion"],
          description: "Filter by decision type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'consent', 'cookies', 'transfers'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_dp_get_decision",
    description:
      "Get a specific HDPA decision by reference number (e.g., 'HDPA-2022-001', 'GN-2022-1').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "HDPA decision reference (e.g., 'HDPA-2022-001', 'GN-2022-1')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "gr_dp_search_guidelines",
    description:
      "Search HDPA guidance documents: guidelines, opinions, recommendations, and circulars. Covers GDPR implementation, DPIA methodology, cookie consent, CCTV, and more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'DPIA', 'cookies', 'CCTV surveillance')",
        },
        type: {
          type: "string",
          enum: ["guideline", "opinion", "recommendation", "circular"],
          description: "Filter by guidance type. Optional.",
        },
        topic: {
          type: "string",
          description: "Filter by topic ID (e.g., 'dpia', 'cookies', 'cctv'). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gr_dp_get_guideline",
    description:
      "Get a specific HDPA guidance document by its database ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "number",
          description: "Guideline database ID (from gr_dp_search_guidelines results)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "gr_dp_list_topics",
    description:
      "List all covered data protection topics with Greek and English names. Use topic IDs to filter decisions and guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_dp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_dp_list_sources",
    description: "List official data sources used by this MCP server.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "gr_dp_check_data_freshness",
    description: "Check when the corpus data was last updated and confirm the source URL.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

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

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
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

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
            "HDPA (Hellenic Data Protection Authority / Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα) MCP server. Provides access to Greek data protection authority decisions, sanctions, reprimands, and official guidance documents.",
          data_source: "HDPA (https://www.dpa.gr/)",
          coverage: {
            decisions: "HDPA sanctions, reprimands, and administrative decisions",
            guidelines: "HDPA guidelines, opinions, recommendations, and circulars",
            topics: "Consent, cookies, transfers, DPIA, breach notification, privacy by design, CCTV, health data, children",
          },
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

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
