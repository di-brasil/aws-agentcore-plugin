#!/usr/bin/env node
/**
 * Amazon Bedrock AgentCore Assistant
 *
 * Multi-source documentation server that gives AI coding assistants accurate,
 * always-fresh knowledge about Amazon Bedrock AgentCore.
 *
 * Sources (all fetched dynamically, configurable via AGENTCORE_SOURCES):
 *   - docs: Developer Guide (llms.txt manifest)
 *   - api_data_plane / api_control_plane: API References (llms.txt)
 *   - boto3_data_plane / boto3_control_plane: Boto3 references (HTML index)
 *   - sdk: AgentCore Python SDK (GitHub README)
 *   - cloudformation: CloudFormation template reference
 *   - cdk_typescript / cdk_python / cdk_java / cdk_dotnet / cdk_go: CDK constructs
 *   - faq: AWS FAQ page
 *
 * Enable/disable sources via AGENTCORE_SOURCES env var:
 *   "all" (default) | "docs,api_data_plane,faq" | "-cdk_java,-cdk_dotnet,-cdk_go"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getIndex, getComponents, searchEntries, buildComponentOverview } from "./doc-index.js";
import { fetchDocPage, PageUnavailableError } from "./fetcher.js";
import { getEnabledSources, getAllSourceIds } from "./sources.js";

const enabledSources = getEnabledSources();
const sourceNames = enabledSources.map(s => `${s.id} (${s.name})`).join(", ");

const server = new McpServer({
  name: "agentcore-assistant",
  version: "4.3.0",
  description: `Amazon Bedrock AgentCore is a fully managed AWS platform for building, deploying, and operating AI agents at scale. It provides: Runtime (serverless agent hosting with session isolation in microVMs, supporting any framework — Strands, LangGraph, CrewAI, Google ADK, OpenAI Agents SDK), Harness (managed agent loop via configuration — no code needed), Memory (short-term and long-term memory with semantic, summary, user-preference, and episodic strategies), Gateway (unified AI gateway connecting agents to tools via MCP, HTTP, and inference routing with 1-click integrations for Slack, Jira, Salesforce), Identity (workload identity, OAuth, API keys, Token Vault), Browser (managed remote Chrome for web automation), Code Interpreter (sandboxed Python/JS/TS execution), Web Search (managed search with no API keys), Observability (OpenTelemetry tracing via CloudWatch), Policy (Cedar-based fine-grained access control), Evaluations (13 built-in evaluators for continuous quality scoring), and Agent Registry (discover and share agents across an org). This MCP server provides live documentation, API references, boto3 methods, Python SDK, CDK constructs (TypeScript/Python/Java/.NET/Go), CloudFormation templates, and FAQs from ${enabledSources.length} official AWS sources (${enabledSources.map(s => s.id).join(", ")}). Uses stdio transport — no ports, no conflicts. All content fetched dynamically — never stale.`,
});

server.tool(
  "list_agentcore_components",
  `Returns a structured overview of all Amazon Bedrock AgentCore components and documentation sources.

Call this FIRST to understand what's available. Shows:
- Each component/section with its documentation URL and page count
- Key sub-topics with descriptions
- Which source each section comes from (docs, api_data_plane, api_control_plane, boto3_data_plane, boto3_control_plane, sdk, cloudformation, cdk_*, faq)

Sources are loaded dynamically — new pages published by AWS appear automatically.

Pass a source ID to see only that source's components, or a component name to filter across all sources.`,
  {
    source: z.enum(["all", ...getAllSourceIds()] as [string, ...string[]]).optional().describe("Filter by source (docs, api_data_plane, api_control_plane, boto3_data_plane, boto3_control_plane, sdk, cloudformation, cdk_typescript, cdk_python, cdk_java, cdk_dotnet, cdk_go, faq). Default: all"),
    component: z.string().optional().describe("Filter by component name (e.g., 'memory', 'runtime', 'gateway')"),
  },
  async ({ source, component }) => {
    let components = await getComponents();

    if (components.length === 0) {
      return {
        content: [{ type: "text", text: "Failed to load index. Check internet connectivity." }]
      };
    }

    if (source && source !== "all") {
      components = components.filter(c => c.sourceId === source);
    }

    if (component) {
      components = components.filter(c =>
        c.name === component.toLowerCase() ||
        c.sectionTitle.toLowerCase().includes(component.toLowerCase())
      );

      if (components.length === 0) {
        return {
          content: [{ type: "text", text: `No components matching "${component}" found in ${source || "all"} sources.` }]
        };
      }
    }

    const summaries = components.map(c => buildComponentOverview(c));
    const index = await getIndex();

    return {
      content: [{
        type: "text",
        text: `# Amazon Bedrock AgentCore\n\n` +
          `*${index.length} pages indexed from ${enabledSources.length} sources. All content fetched live.*\n\n` +
          `**Active sources:** ${enabledSources.map(s => s.id).join(", ")}\n\n---\n\n` +
          summaries.join("\n---\n\n")
      }]
    };
  }
);

server.tool(
  "search_agentcore_docs",
  `Search across all AgentCore documentation sources — developer guide, API references (data plane + control plane), boto3 SDK, Python SDK, CloudFormation, CDK (5 languages), and FAQs.

Returns ranked results with live content snippets. The index covers 1800+ pages across all enabled sources, dynamically discovered from official AWS manifests.

Filter by source to narrow results:
- "docs" — Developer guide (how-to, concepts, getting started)
- "api_data_plane" — API operations for invoking agents, memory, browser, etc.
- "api_control_plane" — API operations for creating/managing resources
- "boto3_data_plane" — Python boto3 methods for bedrock-agentcore (data plane)
- "boto3_control_plane" — Python boto3 methods for bedrock-agentcore-control (control plane)
- "sdk" — AgentCore Python SDK (bedrock-agentcore package)
- "cloudformation" — CloudFormation resource types for IaC
- "cdk_typescript" / "cdk_python" / "cdk_java" / "cdk_dotnet" / "cdk_go" — CDK construct references
- "faq" — Frequently asked questions

Tip: Call list_agentcore_components first to understand available terminology.`,
  {
    query: z.string().describe("Search query — include the topic in your query for best results (e.g., 'runtime deploy strands', 'memory strategies long-term', 'CreateGateway parameters', 'invoke_harness boto3', 'pricing regions')"),
    source: z.enum(["all", ...getAllSourceIds()] as [string, ...string[]]).optional().describe("Filter to a specific source. Default: all"),
    max_results: z.number().min(1).max(10).optional().describe("Max results. Default: 5"),
  },
  async ({ query, source, max_results }) => {
    const index = await getIndex();

    if (index.length === 0) {
      return {
        content: [{ type: "text", text: "Failed to load index. Check internet connectivity." }]
      };
    }

    const results = searchEntries(index, query, {
      sourceId: source || "all",
      maxResults: max_results || 5,
    });

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No results for "${query}".\n\nTips:\n- Try broader terms or include the component name in your query (e.g., "memory strategies" instead of just "strategies")\n- Call list_agentcore_components to see available topics and terminology\n- Use source filter to narrow: docs, api_data_plane, api_control_plane, boto3_data_plane, boto3_control_plane, sdk, cloudformation, cdk_typescript, faq\n\nIndex has ${index.length} pages across ${enabledSources.length} sources.`
        }]
      };
    }

    const hydrated: string[] = [];
    for (const entry of results.slice(0, 3)) {
      try {
        const content = await fetchDocPage(entry.url);
        const snippet = content.slice(0, 1500);
        hydrated.push(
          `### ${entry.title}\n` +
          `**URL:** ${entry.url}\n` +
          `**Source:** ${entry.sourceId} | **Component:** ${entry.component}\n` +
          (entry.description ? `**Summary:** ${entry.description}\n` : "") +
          `\n${snippet}${content.length > 1500 ? "\n\n*[Truncated — use fetch_agentcore_doc for full content]*" : ""}`
        );
      } catch {
        hydrated.push(
          `### ${entry.title}\n` +
          `**URL:** ${entry.url}\n` +
          `**Source:** ${entry.sourceId} | **Component:** ${entry.component}\n` +
          (entry.description ? `**Summary:** ${entry.description}\n` : "") +
          `\n*Content unavailable — use fetch_agentcore_doc to retry.*`
        );
      }
    }

    const remaining = results.slice(3);
    let remainingText = "";
    if (remaining.length > 0) {
      remainingText = "\n\n---\n\n**More results:**\n" +
        remaining.map(e => `- [${e.title}](${e.url}) [${e.sourceId}]${e.description ? ` — ${e.description}` : ""}`).join("\n");
    }

    return {
      content: [{ type: "text", text: hydrated.join("\n\n---\n\n") + remainingText }]
    };
  }
);

/** Last path segment of a doc URL without the .html extension, lowercased. */
function urlSlug(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const last = path.split("/").pop() || "";
    return last.replace(/\.html?$/i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Directory portion of a URL — origin + path up to and including the last slash. */
function urlDir(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/[^/]*$/, "")}`;
  } catch {
    return "";
  }
}

/** Normalized Levenshtein similarity in [0,1] over alphanumerics; 1 = identical. */
function slugSimilarity(a: string, b: string): number {
  const s = a.replace(/[^a-z0-9]/g, "");
  const t = b.replace(/[^a-z0-9]/g, "");
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

/**
 * When a doc URL is gone or renamed, recover the real page from the loaded
 * index: pick the index entry in the same doc directory whose slug is the
 * closest match to the requested one (e.g. `memory-getting-started` →
 * `memory-get-started`). Returns the recovered page, or null when nothing is
 * close enough — meaning the content was genuinely removed, not just renamed.
 */
async function recoverRenamedDoc(requestedUrl: string): Promise<{ url: string; title: string; content: string } | null> {
  const slug = urlSlug(requestedUrl);
  const dir = urlDir(requestedUrl);
  if (!slug || !dir) return null;

  let index;
  try {
    index = await getIndex();
  } catch {
    return null;
  }

  let best: { url: string; title: string; score: number } | null = null;
  for (const entry of index) {
    if (urlDir(entry.url) !== dir) continue; // stay within the same doc section
    const cand = urlSlug(entry.url);
    if (!cand || cand === slug) continue; // skip empty or the identical (dead) slug
    const score = slugSimilarity(slug, cand);
    if (!best || score > best.score) {
      best = { url: entry.url, title: entry.title, score };
    }
  }

  if (!best || best.score < 0.6) return null; // no confident match

  try {
    const content = await fetchDocPage(best.url);
    return { url: best.url, title: best.title, content };
  } catch {
    return null; // recovered candidate is also unavailable
  }
}

server.tool(
  "fetch_agentcore_doc",
  `Fetch the full content of a documentation page by URL. Returns the complete page converted to Markdown.

Use when search snippets are truncated and you need:
- Full code examples with all parameters
- Complete API operation details (request/response schemas)
- Step-by-step tutorial content
- Configuration reference tables

Works with any URL from the search results — developer guide, API reference, boto3 reference, or SDK pages.

Results are cached locally (default 60 min TTL) so repeated fetches are instant.`,
  {
    url: z.string().describe("Full URL to fetch from search results"),
  },
  async ({ url }) => {
    const MAX_CHARS = 20000;
    const clamp = (content: string) =>
      content.length > MAX_CHARS
        ? `${content.slice(0, MAX_CHARS)}\n\n*[Truncated at ${MAX_CHARS} characters — page is ${content.length} characters. Ask for a narrower section or a different page if you need more.]*`
        : content;

    try {
      const content = await fetchDocPage(url);
      return {
        content: [{ type: "text", text: `**Source:** ${url}\n\n---\n\n${clamp(content)}` }]
      };
    } catch (err) {
      if (err instanceof PageUnavailableError) {
        const recovered = await recoverRenamedDoc(url);
        if (recovered) {
          return {
            content: [{
              type: "text",
              text: `*Note: \`${url}\` is no longer available (removed or renamed). ` +
                    `Showing the closest current page instead.*\n\n` +
                    `**Source:** ${recovered.url}\n\n---\n\n${clamp(recovered.content)}`
            }]
          };
        }
        return {
          content: [{
            type: "text",
            text: `\`${url}\` is no longer available — the page appears to have been removed or renamed, ` +
                  `and no close replacement was found in the index. ` +
                  `Use \`search_agentcore_docs\` to find the current page for this topic.`
          }]
        };
      }
      return {
        content: [{ type: "text", text: `Failed to fetch ${url}: ${(err as Error).message}` }]
      };
    }
  }
);

async function main() {
  getIndex().catch(() => {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
