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
 * Thrown when a requested doc URL resolves to no real article content —
 * typically because the page was removed or renamed and AWS 302-redirects
 * it to the section root, which serves only a tiny client-side redirect
 * shell. Carries the final landing URL so callers can attempt recovery or
 * report precisely where the request ended up instead of returning junk.
 */
export class PageUnavailableError extends Error {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  constructor(requestedUrl: string, finalUrl: string) {
    const where = finalUrl && finalUrl !== requestedUrl ? ` (redirected to ${finalUrl})` : "";
    super(`No article content for ${requestedUrl}${where} — the page may have been removed or renamed.`);
    this.name = "PageUnavailableError";
    this.requestedUrl = requestedUrl;
    this.finalUrl = finalUrl;
  }
}

interface RawResult {
  body: string;
  /** URL the request actually ended at, after following any redirects. */
  finalUrl: string;
}

/**
 * Fetch raw content from a URL, following redirects (max 5) and reporting the
 * final landing URL. Times out at 15s.
 */
function fetchRawWithMeta(url: string, redirectCount = 0): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "AgentCore-Assistant/4.3" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve the (possibly relative) Location against the current URL so
        // the final URL we report is always absolute.
        const next = new URL(res.headers.location, url).toString();
        res.resume(); // drain the redirect response so the socket can be reused
        fetchRawWithMeta(next, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf-8"), finalUrl: url }));
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
 * Fetch raw content from a URL. Follows redirects, times out at 15s.
 */
export function fetchRawUrl(url: string): Promise<string> {
  return fetchRawWithMeta(url).then((r) => r.body);
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

/** Compare two URLs by host + path only (ignoring query/fragment/trailing slash). */
function samePath(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "");
  } catch {
    return a === b;
  }
}

/**
 * AWS serves a tiny client-side `meta refresh` / frameset stub (well under 2KB,
 * no article body) when a page has been removed or renamed and the request is
 * 302-redirected to the section root. Detect that shape so we don't hand back
 * near-empty content as if the fetch succeeded.
 */
function looksLikeRedirectShell(html: string): boolean {
  return html.length < 2000 && (/http-equiv=["']?refresh/i.test(html) || /<frame\b/i.test(html));
}

/**
 * Fetch a documentation page, convert to Markdown, and cache.
 * Returns cached content if within TTL, otherwise re-fetches.
 *
 * Throws PageUnavailableError when the URL resolves to no real content — a
 * redirect shell, or a redirect to a different path that yields near-empty
 * output — rather than silently returning the empty stub.
 */
export async function fetchDocPage(url: string): Promise<string> {
  const ttl = getCacheTTL();

  const cached = cache.get(url);
  if (cached && (Date.now() - cached.timestamp) < ttl) {
    return cached.content;
  }

  const { body, finalUrl } = await fetchRawWithMeta(url);
  const markdown = htmlToMarkdown(body);

  const redirectedAway = !samePath(url, finalUrl);
  const nearEmpty = markdown.trim().length < 200;
  if (looksLikeRedirectShell(body) || (redirectedAway && nearEmpty)) {
    throw new PageUnavailableError(url, finalUrl);
  }

  cache.set(url, { content: markdown, timestamp: Date.now() });

  return markdown;
}
