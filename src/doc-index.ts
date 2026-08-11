/**
 * Multi-source documentation index.
 *
 * Fetches and parses documentation manifests from multiple sources
 * (llms.txt, boto3 index pages, GitHub READMEs, FAQ pages) into
 * a unified searchable index with per-source component summaries.
 */

import { fetchRawUrl } from "./fetcher.js";
import { SourceConfig, getEnabledSources } from "./sources.js";

export interface DocEntry {
  url: string;
  title: string;
  description: string;
  sourceId: string;
  component: string;
  tags: string[];
}

export interface ComponentSummary {
  name: string;
  sectionTitle: string;
  sectionUrl: string;
  sourceId: string;
  subPages: Array<{ title: string; description: string }>;
}

interface ParseResult {
  entries: DocEntry[];
  components: ComponentSummary[];
}

let _result: ParseResult | null = null;
let _loadPromise: Promise<ParseResult> | null = null;

// === PARSERS ===

function parseLlmsTxt(content: string, source: SourceConfig): ParseResult {
  const entries: DocEntry[] = [];
  const components: ComponentSummary[] = [];
  let currentSection = "";
  let currentComponent: ComponentSummary | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    const h2Match = trimmed.match(/^##\s+\[(.+?)\]\((.+?)\)/);
    if (h2Match) {
      if (currentComponent) components.push(currentComponent);
      const title = h2Match[1];
      const url = normalizeUrl(h2Match[2], source.baseUrl);
      currentSection = title;
      const component = inferComponent(url, title);
      currentComponent = { name: component, sectionTitle: title, sectionUrl: url, sourceId: source.id, subPages: [] };
      entries.push({ url, title, description: "", sourceId: source.id, component, tags: inferTags(title, url, component, source.id) });
      continue;
    }

    const h3Match = trimmed.match(/^###\s+\[(.+?)\]\((.+?)\)/);
    if (h3Match) {
      const title = h3Match[1];
      const url = normalizeUrl(h3Match[2], source.baseUrl);
      const component = inferComponent(url, currentSection);
      entries.push({ url, title, description: "", sourceId: source.id, component, tags: inferTags(title, url, component, source.id) });
      if (currentComponent) currentComponent.subPages.push({ title, description: "" });
      continue;
    }

    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch && !headingMatch[1].startsWith("[")) {
      currentSection = headingMatch[1];
      continue;
    }

    const itemMatch = trimmed.match(/^-\s+\[(.+?)\]\((.+?)\)(?::\s*(.*))?/);
    if (itemMatch) {
      const title = itemMatch[1];
      const url = normalizeUrl(itemMatch[2], source.baseUrl);
      const description = itemMatch[3] || "";
      const component = inferComponent(url, currentSection);
      entries.push({ url, title, description, sourceId: source.id, component, tags: inferTags(title, url, component, source.id) });
      if (currentComponent) currentComponent.subPages.push({ title, description });
      continue;
    }

    // Standalone paragraph as description for previous entry
    if (trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("-") && !trimmed.startsWith("[") && !trimmed.startsWith(">")) {
      if (currentComponent && currentComponent.subPages.length > 0) {
        const lastPage = currentComponent.subPages[currentComponent.subPages.length - 1];
        if (!lastPage.description) {
          lastPage.description = trimmed;
          const lastEntry = entries[entries.length - 1];
          if (lastEntry && lastEntry.title === lastPage.title && !lastEntry.description) {
            lastEntry.description = trimmed;
          }
        }
      }
    }
  }

  if (currentComponent) components.push(currentComponent);
  return { entries, components };
}

/**
 * Infer an AgentCore domain (memory, gateway, runtime, ...) from a boto3
 * method name so entries can be filtered/searched the same way as the
 * other sources, instead of all bucketing under the raw source id.
 */
function inferBoto3Component(methodName: string): string {
  const name = methodName.toLowerCase();
  if (name.includes("memory")) return "memory";
  if (name.includes("gateway") || name.includes("target")) return "gateway";
  if (name.includes("harness")) return "harness";
  if (name.includes("browser")) return "browser";
  if (name.includes("code_interpreter")) return "code-interpreter";
  if (name.includes("workload") || name.includes("credential") || name.includes("oauth") || name.includes("token") || name.includes("identity")) return "identity";
  if (name.includes("evaluat") || name.includes("ab_test")) return "evaluations";
  if (name.includes("payment")) return "payments";
  if (name.includes("policy")) return "policy";
  if (name.includes("registry") || name.includes("agent_card")) return "registry";
  if (name.includes("runtime") || name.includes("endpoint") || name.includes("invoke")) return "runtime";
  return "agentcore";
}

function parseBoto3Index(content: string, source: SourceConfig): ParseResult {
  const entries: DocEntry[] = [];
  const methods: Array<{ title: string; description: string }> = [];

  // Match HTML links: <a href="bedrock-agentcore*/client/method.html">method_name</a>
  const htmlLinkRegex = /<a[^>]+href="([^"]*\/client\/[^"]+\.html)"[^>]*>([^<]+)<\/a>/g;

  let match;
  const seen = new Set<string>();

  while ((match = htmlLinkRegex.exec(content)) !== null) {
    const relPath = match[1];
    const methodName = match[2].replace(/\\/g, "").trim();
    if (seen.has(methodName)) continue;
    seen.add(methodName);
    if (["can_paginate", "close", "get_paginator", "get_waiter"].includes(methodName)) continue;

    const url = source.baseUrl + relPath;
    const serviceName = source.id === "boto3_control_plane" ? "bedrock-agentcore-control" : "bedrock-agentcore";
    const component = inferBoto3Component(methodName);
    entries.push({
      url,
      title: methodName,
      description: `boto3 ${serviceName} client method`,
      sourceId: source.id,
      component,
      tags: [component, source.id, "boto3", "sdk", "python", methodName.split("_")[0]],
    });
    methods.push({ title: methodName, description: "" });
  }

  const serviceName = source.id === "boto3_control_plane" ? "bedrock-agentcore-control" : "bedrock-agentcore";

  // One ComponentSummary per inferred AgentCore domain, not one per source.
  // list_agentcore_components filters on ComponentSummary.name, so a single
  // source-named summary made `component: "memory"` report "no components
  // found" even though the memory method entries exist and are searchable.
  // The source id stays a valid filter so `source: boto3_data_plane` still works.
  const byComponent = new Map<string, Array<{ title: string; description: string }>>();
  for (const entry of entries) {
    const group = byComponent.get(entry.component) ?? [];
    group.push({ title: entry.title, description: "" });
    byComponent.set(entry.component, group);
  }

  const components: ComponentSummary[] = [...byComponent].map(([name, subPages]) => ({
    name,
    sectionTitle: `Boto3 ${serviceName} Client — ${name}`,
    sectionUrl: source.indexUrl,
    sourceId: source.id,
    subPages,
  }));

  // ponytail: keep the flat all-methods summary too — it's the only place the
  // full client method list appears, and `source: boto3_*` overviews rely on it.
  components.push({
    name: source.id,
    sectionTitle: `Boto3 ${serviceName} Client`,
    sectionUrl: source.indexUrl,
    sourceId: source.id,
    subPages: methods,
  });

  return { entries, components };
}

function parseGithubReadme(content: string, source: SourceConfig): ParseResult {
  const entries: DocEntry[] = [];

  // Extract links from the README
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const title = match[1];
    const url = match[2];
    // Only include relevant links
    if (url.includes("amazon") || url.includes("aws") || url.includes("strands") || url.includes("agentcore")) {
      entries.push({
        url,
        title,
        description: "",
        sourceId: source.id,
        component: "sdk",
        tags: ["sdk", "python", "github"],
      });
    }
  }

  // The README itself is a single searchable entry
  entries.unshift({
    url: source.baseUrl,
    title: "AgentCore Python SDK (bedrock-agentcore)",
    description: "Deploy agents with any framework (Strands, LangGraph, CrewAI, Google ADK, OpenAI) to AgentCore Runtime. Includes MemoryClient, AG-UI protocol, A2A protocol support.",
    sourceId: source.id,
    component: "sdk",
    tags: ["sdk", "python", "deploy", "strands", "langgraph", "crewai", "runtime", "memory", "ag-ui", "a2a"],
  });

  const component: ComponentSummary = {
    name: "sdk",
    sectionTitle: "AgentCore Python SDK (bedrock-agentcore)",
    sectionUrl: source.baseUrl,
    sourceId: source.id,
    subPages: [
      { title: "BedrockAgentCoreApp", description: "Runtime entrypoint wrapper for deploying agents to AgentCore" },
      { title: "MemoryClient", description: "Client for memory operations — create, store events, retrieve" },
      { title: "AG-UI Protocol", description: "Deploy agents using AG-UI protocol over SSE and WebSocket" },
      { title: "A2A Protocol", description: "Agent-to-Agent protocol support for multi-agent systems" },
      { title: "Framework Support", description: "Works with Strands, LangGraph, CrewAI, Google ADK, OpenAI Agents SDK" },
    ],
  };

  return { entries, components: [component] };
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * AWS marketing pages (e.g. the FAQ page) render Q&A from a client-side data
 * blob embedded as <script type="application/json"> — the visible <h2>/<h3>
 * tags in the raw HTML are empty shells with no text content. Extract
 * directly from that JSON rather than trying to scrape the DOM.
 */
function extractFaqFromJson(content: string, source: SourceConfig): ParseResult | null {
  const entries: DocEntry[] = [];
  const subPages: Array<{ title: string; description: string }> = [];

  const scriptRegex = /<script type="application\/json">([\s\S]*?)<\/script>/g;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(content)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scriptMatch[1]);
    } catch {
      continue;
    }

    const items = (parsed as any)?.data?.items;
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      const heading = item?.fields?.itemHeading;
      const longLoc = item?.fields?.itemLongLoc;
      if (typeof heading !== "string" || typeof longLoc !== "string") continue;
      const question = heading.trim();
      if (!question.endsWith("?")) continue;

      const desc = stripHtmlToText(longLoc).slice(0, 200);
      entries.push({
        url: source.indexUrl,
        title: question,
        description: desc,
        sourceId: source.id,
        component: "faq",
        tags: ["faq", ...inferFaqTags(question)],
      });
      subPages.push({ title: question, description: desc });
    }
  }

  if (entries.length === 0) return null;

  const component: ComponentSummary = {
    name: "faq",
    sectionTitle: "AgentCore Frequently Asked Questions",
    sectionUrl: source.indexUrl,
    sourceId: source.id,
    subPages,
  };

  return { entries, components: [component] };
}

function parseFaqPage(content: string, source: SourceConfig): ParseResult {
  const fromJson = extractFaqFromJson(content, source);
  if (fromJson) return fromJson;

  const entries: DocEntry[] = [];
  const subPages: Array<{ title: string; description: string }> = [];

  // Fallback: extract questions from markdown-style ### headings, in case
  // the page ever ships as (or is proxied through) a markdown/llms.txt-like
  // format instead of the JSON-driven HTML it uses today.
  const lines = content.split("\n");
  let currentQuestion = "";
  let currentAnswer = "";

  for (const line of lines) {
    const qMatch = line.match(/^#{2,3}\s+(.+\?)\s*$/);
    if (qMatch) {
      // Save previous Q&A
      if (currentQuestion) {
        const desc = currentAnswer.trim().slice(0, 200);
        entries.push({
          url: source.indexUrl,
          title: currentQuestion,
          description: desc,
          sourceId: source.id,
          component: "faq",
          tags: ["faq", ...inferFaqTags(currentQuestion)],
        });
        subPages.push({ title: currentQuestion, description: desc });
      }
      currentQuestion = qMatch[1];
      currentAnswer = "";
      continue;
    }

    if (currentQuestion && line.trim().length > 0) {
      currentAnswer += " " + line.trim();
    }
  }

  // Save last Q&A
  if (currentQuestion) {
    const desc = currentAnswer.trim().slice(0, 200);
    entries.push({
      url: source.indexUrl,
      title: currentQuestion,
      description: desc,
      sourceId: source.id,
      component: "faq",
      tags: ["faq", ...inferFaqTags(currentQuestion)],
    });
    subPages.push({ title: currentQuestion, description: desc });
  }

  // If no structured Q&A found, treat whole page as single entry
  if (entries.length === 0) {
    entries.push({
      url: source.indexUrl,
      title: "AgentCore FAQs",
      description: "Frequently asked questions about Amazon Bedrock AgentCore",
      sourceId: source.id,
      component: "faq",
      tags: ["faq", "general", "pricing", "regions"],
    });
  }

  const component: ComponentSummary = {
    name: "faq",
    sectionTitle: "AgentCore Frequently Asked Questions",
    sectionUrl: source.indexUrl,
    sourceId: source.id,
    subPages,
  };

  return { entries, components: [component] };
}

// === HELPERS ===

function normalizeUrl(url: string, baseUrl: string): string {
  if (url.startsWith("http")) return url.replace(/\.md$/, ".html");
  return baseUrl + url.replace(/\.md$/, ".html");
}

function inferComponent(url: string, currentSection: string): string {
  const path = url.toLowerCase();
  if (path.includes("harness")) return "harness";
  if (path.includes("runtime") || path.includes("agents-tools-runtime")) return "runtime";
  if (path.includes("memory")) return "memory";
  if (path.includes("gateway")) return "gateway";
  if (path.includes("identity") || path.includes("workload") || path.includes("credential") || path.includes("oauth") || path.includes("jwt")) return "identity";
  if (path.includes("browser")) return "browser";
  if (path.includes("code-interpreter") || path.includes("codeinterpreter")) return "code-interpreter";
  if (path.includes("web-search")) return "web-search";
  if (path.includes("observability")) return "observability";
  if (path.includes("policy") || path.includes("cedar")) return "policy";
  if (path.includes("security") || path.includes("iam")) return "security";
  if (path.includes("evaluation") || path.includes("evaluator")) return "evaluations";
  if (path.includes("payment")) return "payments";
  if (path.includes("optimization") || path.includes("configuration-bundle")) return "optimization";
  if (path.includes("registry")) return "registry";

  const sec = currentSection.toLowerCase();
  if (sec.includes("harness")) return "harness";
  if (sec.includes("runtime")) return "runtime";
  if (sec.includes("memory")) return "memory";
  if (sec.includes("gateway")) return "gateway";
  if (sec.includes("identity")) return "identity";
  if (sec.includes("browser")) return "browser";
  if (sec.includes("code interpreter")) return "code-interpreter";
  if (sec.includes("observability")) return "observability";
  if (sec.includes("policy")) return "policy";
  if (sec.includes("evaluation")) return "evaluations";
  if (sec.includes("payment")) return "payments";
  if (sec.includes("registry")) return "registry";

  return "agentcore";
}

function inferTags(title: string, url: string, component: string, sourceId: string): string[] {
  const tags: string[] = [component, sourceId];
  const text = `${title} ${url}`.toLowerCase();
  const tagKeywords: Record<string, string[]> = {
    "getting-started": ["get started", "getting started", "quickstart"],
    "deploy": ["deploy", "create"],
    "mcp": ["mcp"],
    "streaming": ["streaming", "websocket"],
    "auth": ["auth", "oauth", "jwt", "credential"],
    "strands": ["strands"],
    "langgraph": ["langgraph"],
  };
  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    if (keywords.some(k => text.includes(k))) tags.push(tag);
  }
  return tags;
}

function inferFaqTags(question: string): string[] {
  const q = question.toLowerCase();
  const tags: string[] = [];
  if (q.includes("runtime")) tags.push("runtime");
  if (q.includes("memory")) tags.push("memory");
  if (q.includes("gateway")) tags.push("gateway");
  if (q.includes("identity")) tags.push("identity");
  if (q.includes("browser")) tags.push("browser");
  if (q.includes("code interpreter")) tags.push("code-interpreter");
  if (q.includes("observability")) tags.push("observability");
  if (q.includes("policy")) tags.push("policy");
  if (q.includes("evaluation")) tags.push("evaluations");
  if (q.includes("payment")) tags.push("payments");
  if (q.includes("harness")) tags.push("harness");
  if (q.includes("registry")) tags.push("registry");
  if (q.includes("pricing") || q.includes("charged") || q.includes("cost")) tags.push("pricing");
  if (q.includes("region")) tags.push("regions");
  if (q.includes("framework")) tags.push("frameworks");
  if (q.includes("model")) tags.push("models");
  return tags;
}

// === LOAD & SEARCH ===

function parseSinglePage(source: SourceConfig): ParseResult {
  const entry: DocEntry = {
    url: source.indexUrl,
    title: source.name,
    description: source.description,
    sourceId: source.id,
    component: source.id.startsWith("cdk") ? "cdk" : source.id,
    tags: [source.id, "cdk", "infrastructure-as-code", "iac"],
  };

  const component: ComponentSummary = {
    name: source.id,
    sectionTitle: source.name,
    sectionUrl: source.indexUrl,
    sourceId: source.id,
    subPages: [{ title: source.name, description: source.description }],
  };

  return { entries: [entry], components: [component] };
}

async function fetchAndParse(source: SourceConfig): Promise<ParseResult> {
  try {
    if (source.type === "single_page") {
      return parseSinglePage(source);
    }
    const content = await fetchRawUrl(source.indexUrl);
    switch (source.type) {
      case "llms_txt": return parseLlmsTxt(content, source);
      case "boto3_index": return parseBoto3Index(content, source);
      case "github_readme": return parseGithubReadme(content, source);
      case "faq_page": return parseFaqPage(content, source);
    }
  } catch (err) {
    console.error(`[${source.id}] Failed to load: ${(err as Error).message}`);
    return { entries: [], components: [] };
  }
}

async function loadAll(): Promise<ParseResult> {
  const sources = getEnabledSources();
  const results = await Promise.all(sources.map(s => fetchAndParse(s)));

  const entries: DocEntry[] = [];
  const components: ComponentSummary[] = [];
  for (const r of results) {
    entries.push(...r.entries);
    components.push(...r.components);
  }
  return { entries, components };
}

async function getResult(): Promise<ParseResult> {
  if (_result !== null) return _result;
  if (_loadPromise === null) {
    _loadPromise = loadAll().then(r => { _result = r; return r; });
  }
  return _loadPromise;
}

export async function getIndex(): Promise<DocEntry[]> {
  return (await getResult()).entries;
}

export async function getComponents(): Promise<ComponentSummary[]> {
  return (await getResult()).components;
}

export async function reloadIndex(): Promise<DocEntry[]> {
  _result = null;
  _loadPromise = null;
  return getIndex();
}

export function buildComponentOverview(comp: ComponentSummary): string {
  const described = comp.subPages.filter(p => p.description.length > 0);
  const undescribed = comp.subPages.filter(p => p.description.length === 0);

  let overview = `## ${comp.sectionTitle}\n\n`;
  overview += `**Source:** ${comp.sourceId} | **Documentation:** ${comp.sectionUrl}\n`;
  overview += `**Pages:** ${comp.subPages.length}\n\n`;

  if (described.length > 0) {
    overview += "**Key topics:**\n";
    for (const page of described.slice(0, 12)) {
      overview += `- **${page.title}** — ${page.description}\n`;
    }
    if (described.length > 12) {
      overview += `- ...and ${described.length - 12} more\n`;
    }
  }

  if (undescribed.length > 0 && described.length < 8) {
    const additional = undescribed.slice(0, 8 - described.length);
    if (additional.length > 0) {
      overview += "\n**Additional topics:** " + additional.map(p => p.title).join(", ");
      if (undescribed.length > additional.length) overview += `, and ${undescribed.length - additional.length} more`;
      overview += "\n";
    }
  }

  return overview;
}

/**
 * Words too common in natural-language questions ("how do I deploy an agent")
 * or in AWS reference titles ("Common Parameters", "API Reference") to carry
 * signal. Without this, a query's stopwords score the same +10 title hit as its
 * one distinctive term, so generic pages outrank the exact match — "CreateGateway
 * parameters" ranked CreateGateway below two "Common Parameters" pages.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from",
  "how", "in", "is", "it", "me", "my", "of", "on", "or", "the", "to", "use",
  "using", "what", "when", "where", "which", "who", "why", "with", "you", "your",
  "common", "guide", "overview", "parameters", "reference",
]);

export function searchEntries(entries: DocEntry[], query: string, options?: { sourceId?: string; maxResults?: number }): DocEntry[] {
  const { sourceId, maxResults = 5 } = options || {};
  const queryLower = query.toLowerCase();
  const rawTerms = queryLower.split(/\s+/).filter(t => t.length > 1);
  // Keep the raw terms when a query is nothing but stopwords, so
  // "what is a gateway" still beats returning nothing at all.
  const meaningful = rawTerms.filter(t => !STOPWORDS.has(t));
  const terms = meaningful.length > 0 ? meaningful : rawTerms;

  let pool = entries;
  if (sourceId && sourceId !== "all") pool = pool.filter(e => e.sourceId === sourceId);

  const scored = pool.map(entry => {
    let score = 0;
    const titleLower = entry.title.toLowerCase();
    const descLower = entry.description.toLowerCase();

    if (titleLower.includes(queryLower)) score += 20;
    if (descLower.includes(queryLower)) score += 12;

    for (const term of terms) {
      if (titleLower.includes(term)) score += 10;
      if (entry.tags.includes(term)) score += 8;
      if (entry.component === term) score += 6;
      if (descLower.includes(term)) score += 4;
      if (entry.url.includes(term)) score += 3;
    }

    return { entry, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry);
}
