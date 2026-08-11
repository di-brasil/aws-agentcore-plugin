/**
 * HTTP fetcher with TTL-based in-memory cache.
 *
 * Responsible for all network I/O in the MCP server:
 *   - fetchRawUrl: Fetches raw content (used for llms.txt, README, boto3 index, FAQ pages)
 *   - fetchDocPage: Fetches HTML doc pages, converts to Markdown, caches with TTL
 *
 * Cache behavior:
 *   - In-memory Map<url, {content, timestamp}>
 *   - TTL configurable via AGENTCORE_CACHE_TTL_MINUTES (default: 60)
 *   - Expired entries re-fetched transparently on next access
 *   - Cache lost on process restart (intentional — guarantees freshness)
 */

import https from "node:https";
import http from "node:http";

interface CacheEntry {
  content: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function getCacheTTL(): number {
  const envTtl = process.env.AGENTCORE_CACHE_TTL_MINUTES;
  if (envTtl) {
    return parseInt(envTtl, 10) * 60 * 1000;
  }
  return DEFAULT_TTL_MS;
}

export function clearCache(): void {
  cache.clear();
}

/**
 * Fetch raw content from a URL. Follows redirects, times out at 15s.
 */
export function fetchRawUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "AgentCore-Assistant/4.4" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchRawUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

/**
 * Extract the inner HTML of the first element matching `openTagRegex`,
 * tracking nested same-name tags so the extraction doesn't stop at the
 * first nested closing tag (a plain non-greedy regex would).
 */
function extractBalancedTag(html: string, tagName: string, openTagRegex: RegExp): string | null {
  const openMatch = html.match(openTagRegex);
  if (!openMatch || openMatch.index === undefined) return null;

  const start = openMatch.index + openMatch[0].length;
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}>`;

  let depth = 1;
  let i = start;
  while (depth > 0) {
    const nextClose = html.indexOf(closeNeedle, i);
    if (nextClose === -1) return null;
    const nextOpen = html.indexOf(openNeedle, i);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + openNeedle.length;
    } else {
      depth--;
      i = nextClose + closeNeedle.length;
    }
  }

  return html.slice(start, i - closeNeedle.length);
}

/**
 * Known main-content containers across the doc sites this server fetches,
 * tried most-specific first. Falls back to raw HTML (still cleaned of
 * nav/scripts by later steps) when none match.
 */
const CONTENT_CONTAINERS: Array<{ tagName: string; openTagRegex: RegExp }> = [
  // Classic AWS docs (devguide, API reference, CloudFormation reference).
  { tagName: "div", openTagRegex: /<div id="main-col-body"[^>]*>/ },
  // DocFX-generated docs (CDK .NET reference) — must come before the
  // Sphinx `role="main"` selector below: DocFX pages also carry an outer
  // `<div role="main">` wrapper (with sidenav) around this narrower article.
  { tagName: "article", openTagRegex: /<article[^>]*id="_content"[^>]*>/ },
  // pkg.go.dev package pages (CDK Go reference) — the outer <main> is
  // multiple MB (full sidebar + import graph); this scopes to the readme body.
  { tagName: "div", openTagRegex: /<div class="UnitReadme-content[^"]*"[^>]*>/ },
  // Sphinx-generated docs (boto3, CDK Python reference).
  { tagName: "div", openTagRegex: /<div role="main"[^>]*>/ },
  // Generic fallback (e.g. CDK Java reference, and any future single_page source).
  { tagName: "main", openTagRegex: /<main[^>]*>/ },
];

/**
 * Collapse a table cell's inner HTML down to a single line of plain-ish
 * text, resolving links and stripping any block-level tags so it survives
 * as one Markdown table cell (a bare newline or unresolved tag would break
 * the row's `|`-delimited structure).
 */
function cellToInlineText(cellHtml: string): string {
  return cellHtml
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert an HTML <table>'s inner HTML into a GitHub-flavored Markdown
 * table. Falls back to a plain paragraph if the structure doesn't parse
 * (e.g. no rows) so we never drop content, just lose the grid formatting.
 */
function tableToMarkdown(tableHtml: string): string {
  const rowMatches = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!rowMatches || rowMatches.length === 0) return cellToInlineText(tableHtml);

  const rows = rowMatches.map(row => {
    const cellMatches = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    return cellMatches.map(cell => {
      const inner = cell.replace(/^<t[hd][^>]*>/i, "").replace(/<\/t[hd]>$/i, "");
      return cellToInlineText(inner);
    });
  }).filter(row => row.length > 0);

  if (rows.length === 0) return cellToInlineText(tableHtml);

  const colCount = Math.max(...rows.map(r => r.length));
  const pad = (row: string[]) => {
    const padded = [...row];
    while (padded.length < colCount) padded.push("");
    return padded;
  };

  const lines = [
    `\n| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array(colCount).fill("---").join(" | ")} |`,
    ...rows.slice(1).map(r => `| ${pad(r).join(" | ")} |`),
  ];

  return lines.join("\n") + "\n";
}

/**
 * AWS marketing pages (e.g. the AgentCore FAQ page) render their content
 * from a client-side data blob embedded as <script type="application/json">
 * — the visible heading/paragraph tags are empty shells with no text, so the
 * normal DOM-based extraction below finds nothing useful. Detect that shape
 * and render the Q&A directly from the JSON instead.
 */
function extractJsonDrivenFaqMarkdown(html: string): string | null {
  const scriptRegex = /<script type="application\/json">([\s\S]*?)<\/script>/g;
  const sections: string[] = [];
  let scriptMatch;

  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
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
      if (!heading.trim().endsWith("?")) continue;
      sections.push(`## ${heading.trim()}\n\n${longLoc}`);
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Convert raw HTML to readable Markdown.
 * Extracts the main content area and strips navigation/scripts.
 */
export function htmlToMarkdown(html: string): string {
  const jsonFaq = extractJsonDrivenFaqMarkdown(html);
  if (jsonFaq !== null) {
    return htmlToMarkdownInner(jsonFaq);
  }
  return htmlToMarkdownInner(html);
}

function htmlToMarkdownInner(html: string): string {
  let content = html;

  for (const { tagName, openTagRegex } of CONTENT_CONTAINERS) {
    const extracted = extractBalancedTag(html, tagName, openTagRegex);
    if (extracted !== null) {
      content = extracted;
      break;
    }
  }

  content = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[\s\S]*?<\/style>/gi, "");
  content = content.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, tableHtml) => tableToMarkdown(tableHtml));
  content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  content = content.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");
  content = content.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n");
  content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  content = content.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
  content = content.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
  content = content.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  content = content.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  content = content.replace(/<br\s*\/?>/gi, "\n");
  content = content.replace(/<[^>]+>/g, "");
  content = content.replace(/&lt;/g, "<");
  content = content.replace(/&gt;/g, ">");
  content = content.replace(/&amp;/g, "&");
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&nbsp;/g, " ");
  content = content.replace(/\n{3,}/g, "\n\n");
  content = content.trim();

  return content;
}

/**
 * Fetch a documentation page, convert to Markdown, and cache.
 * Returns cached content if within TTL, otherwise re-fetches.
 */
export async function fetchDocPage(url: string): Promise<string> {
  const ttl = getCacheTTL();

  const cached = cache.get(url);
  if (cached && (Date.now() - cached.timestamp) < ttl) {
    return cached.content;
  }

  const html = await fetchRawUrl(url);
  const markdown = htmlToMarkdown(html);

  cache.set(url, { content: markdown, timestamp: Date.now() });

  return markdown;
}
