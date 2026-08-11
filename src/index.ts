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
import { fetchDocPage } from "./fetcher.js";
import { getEnabledSources, getAllSourceIds, isAllowedDocUrl, getAllowedHosts } from "./sources.js";

const enabledSources = getEnabledSources();
const sourceNames = enabledSources.map(s => `${s.id} (${s.name})`).join(", ");

const server = new McpServer({
  name: "agentcore-assistant",
  version: "4.4.0",
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

The top 3 results with distinct URLs are hydrated with a live 1500-character snippet; any further results (up to \`max_results\`) are listed as links only. Raising \`max_results\` gets you more links, not more snippets — use \`fetch_agentcore_doc\` on a URL for its full content.

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

    // Hydrate the top 3 DISTINCT URLs. Several entries can share one URL — all
    // 52 FAQ questions come from a single page, and a few devguide pages are
    // also listed by the sdk source — so hydrating by rank alone fetched the
    // same page 3 times and emitted 3 identical snippets under 3 different
    // headings. Everything not hydrated still appears under "More results".
    const toHydrate: typeof results = [];
    const hydratedUrls = new Set<string>();
    for (const entry of results) {
      if (toHydrate.length >= 3) break;
      if (hydratedUrls.has(entry.url)) continue;
      hydratedUrls.add(entry.url);
      toHydrate.push(entry);
    }

    const hydrated: string[] = [];
    for (const entry of toHydrate) {
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

    const remaining = results.filter(e => !toHydrate.includes(e));
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

server.tool(
  "fetch_agentcore_doc",
  `Fetch the full content of a documentation page by URL. Returns the complete page converted to Markdown.

Use when search snippets are truncated and you need:
- Full code examples with all parameters
- Complete API operation details (request/response schemas)
- Step-by-step tutorial content
- Configuration reference tables

Works with any URL from the search results — developer guide, API reference, boto3 reference, or SDK pages.

Returns at most 20000 characters per call. Large pages (the CDK references run
past 150000 characters) are truncated, and the truncation notice reports the
total length and the exact \`offset\` to pass next. Page through with \`offset\`
to reach content beyond the first window — that is the only way to read the
later part of a single-page reference, since there is no narrower page to ask for.

Results are cached locally (default 60 min TTL) so repeated fetches are instant.`,
  {
    url: z.string().describe("Full URL to fetch from search results"),
    offset: z.number().min(0).optional().describe("Character offset to start from. Use the value reported in a previous truncation notice to page through a large page. Default: 0"),
  },
  async ({ url, offset }) => {
    if (!isAllowedDocUrl(url)) {
      return {
        content: [{
          type: "text",
          text: `Refused to fetch ${url}\n\nThis tool only fetches https pages from the AgentCore documentation hosts it indexes: ${getAllowedHosts().join(", ")}.\n\nUse search_agentcore_docs to find a documentation URL.`
        }]
      };
    }
    try {
      const content = await fetchDocPage(url);
      const MAX_CHARS = 20000;
      const start = Math.min(offset ?? 0, content.length);
      const body = content.slice(start, start + MAX_CHARS);
      const end = start + body.length;

      let notice = "";
      if (start > 0) {
        notice += `*[Resumed at character ${start} of ${content.length}.]*\n\n`;
      }
      if (end < content.length) {
        notice = `${notice}${body}\n\n*[Truncated at ${end} of ${content.length} characters — call again with offset=${end} for the next section.]*`;
      } else {
        notice += body;
      }

      return {
        content: [{ type: "text", text: `**Source:** ${url}\n\n---\n\n${notice}` }]
      };
    } catch (err) {
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
