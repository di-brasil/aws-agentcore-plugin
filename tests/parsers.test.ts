import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// We test the parsers indirectly by mocking fetchRawUrl and calling getIndex/getComponents
// This verifies parsing logic without network calls

vi.mock("../src/fetcher.js", () => ({
  fetchRawUrl: vi.fn(),
  fetchDocPage: vi.fn(),
  clearCache: vi.fn(),
}));

import { fetchRawUrl } from "../src/fetcher.js";

function readFixture(name: string): string {
  return readFileSync(path.resolve(__dirname, "fixtures", name), "utf-8");
}

const MOCK_LLMS_TXT = `# Amazon Bedrock AgentCore Developer Guide

- [Overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.md)
- [Supported AWS Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.md)

## [AgentCore harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.md)

- [Get started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.md): You can use the harness through the AgentCore CLI or directly with AWS SDKs.
- [Tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.md): Tools are declarative.
- [Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.md): The harness automatically persists conversation state.

## [AgentCore Runtime: Host agent or tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.md)

- [How it works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.md): The Runtime handles scaling, session management, and security isolation.

### [Get started with AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-getting-started.md)

You can use the following tutorials to get started.

- [Get started with CLI](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.md): This tutorial shows you how to deploy an agent.

## [AgentCore Memory: Add memory to your agent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.md)

- [Short-term memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/using-memory-short-term.md): Captures turn-by-turn interactions within a session.
- [Long-term memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-memory-long-term.md): Extracts and stores key insights across sessions.
`;

const MOCK_BOTO3_HTML = `
<html><body>
<ul>
<li><a href="bedrock-agentcore/client/invoke_harness.html">invoke_harness</a></li>
<li><a href="bedrock-agentcore/client/create_event.html">create_event</a></li>
<li><a href="bedrock-agentcore/client/can_paginate.html">can_paginate</a></li>
<li><a href="bedrock-agentcore/client/close.html">close</a></li>
<li><a href="bedrock-agentcore/client/start_browser_session.html">start_browser_session</a></li>
</ul>
</body></html>
`;

const MOCK_FAQ_HTML = `
<html><body>
<h2>General</h2>
<h3>What is Amazon Bedrock AgentCore?</h3>
<p>AgentCore is a platform to build, connect, and optimize AI agents at scale.</p>
<h3>Which regions is AgentCore available in?</h3>
<p>AgentCore is available in fifteen AWS Regions.</p>
<h2>Runtime</h2>
<h3>What is AgentCore Runtime?</h3>
<p>AgentCore Runtime is a secure, serverless runtime for deploying agents.</p>
</body></html>
`;

const MOCK_GITHUB_README = `# Bedrock AgentCore SDK

The [bedrock-agentcore](https://github.com/aws/bedrock-agentcore-sdk-python) Python SDK.

## Quick Start

Deploy agents with [Strands](https://strandsagents.com/) or any framework.

See [documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/).
`;

describe("parsers (via getIndex/getComponents)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = process.env.AGENTCORE_SOURCES;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTCORE_SOURCES;
    } else {
      process.env.AGENTCORE_SOURCES = originalEnv;
    }
  });

  describe("llms.txt parser", () => {
    it("parses sections, subsections, and list items", async () => {
      process.env.AGENTCORE_SOURCES = "docs";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_LLMS_TXT);

      const { getIndex, getComponents } = await import("../src/doc-index.js");
      const entries = await getIndex();
      const components = await getComponents();

      // Should have entries for all items
      expect(entries.length).toBeGreaterThanOrEqual(9);

      // Should detect sections as components
      expect(components.length).toBe(3); // harness, runtime, memory

      // Check harness component
      const harness = components.find(c => c.name === "harness");
      expect(harness).toBeDefined();
      expect(harness!.sectionTitle).toBe("AgentCore harness");
      expect(harness!.subPages.length).toBe(3);

      // Check descriptions are parsed
      const toolsPage = harness!.subPages.find(p => p.title === "Tools");
      expect(toolsPage?.description).toBe("Tools are declarative.");
    });

    it("normalizes .md URLs to .html", async () => {
      process.env.AGENTCORE_SOURCES = "docs";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_LLMS_TXT);

      const { getIndex } = await import("../src/doc-index.js");
      const entries = await getIndex();

      for (const entry of entries) {
        expect(entry.url).not.toContain(".md");
        if (entry.url.includes("docs.aws.amazon.com")) {
          expect(entry.url).toMatch(/\.html$/);
        }
      }
    });

    it("infers components from URLs", async () => {
      process.env.AGENTCORE_SOURCES = "docs";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_LLMS_TXT);

      const { getIndex } = await import("../src/doc-index.js");
      const entries = await getIndex();

      const harnessEntries = entries.filter(e => e.component === "harness");
      const runtimeEntries = entries.filter(e => e.component === "runtime");
      const memoryEntries = entries.filter(e => e.component === "memory");

      expect(harnessEntries.length).toBeGreaterThan(0);
      expect(runtimeEntries.length).toBeGreaterThan(0);
      expect(memoryEntries.length).toBeGreaterThan(0);
    });

    it("parses standalone paragraphs as descriptions for previous entry", async () => {
      process.env.AGENTCORE_SOURCES = "docs";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_LLMS_TXT);

      const { getComponents } = await import("../src/doc-index.js");
      const components = await getComponents();

      const runtime = components.find(c => c.name === "runtime");
      const getStarted = runtime?.subPages.find(p => p.title === "Get started with AgentCore Runtime");
      expect(getStarted?.description).toContain("tutorials to get started");
    });
  });

  describe("boto3 parser", () => {
    it("extracts method links from HTML", async () => {
      process.env.AGENTCORE_SOURCES = "boto3_data_plane";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_BOTO3_HTML);

      const { getIndex, getComponents } = await import("../src/doc-index.js");
      const entries = await getIndex();
      const components = await getComponents();

      // Should skip can_paginate and close
      expect(entries.length).toBe(3);
      expect(entries.map(e => e.title)).toContain("invoke_harness");
      expect(entries.map(e => e.title)).toContain("create_event");
      expect(entries.map(e => e.title)).toContain("start_browser_session");
      expect(entries.map(e => e.title)).not.toContain("can_paginate");
      expect(entries.map(e => e.title)).not.toContain("close");

      // One summary per inferred AgentCore domain, plus the flat all-methods
      // summary named after the source. A single source-named summary made
      // list_agentcore_components report "no components found" for
      // `component: "memory"` even though memory method entries exist.
      const names = components.map(c => c.name);
      expect(names).toContain("boto3_data_plane");
      expect(names).toContain("harness");
      expect(names).toContain("browser");

      // Grouped by the component each method infers, so a domain filter finds them.
      expect(components.find(c => c.name === "harness")!.subPages.map(p => p.title)).toEqual(["invoke_harness"]);
      expect(components.find(c => c.name === "browser")!.subPages.map(p => p.title)).toEqual(["start_browser_session"]);
      // The flat all-methods summary is still there for `source:` overviews.
      expect(components.find(c => c.name === "boto3_data_plane")!.subPages.length).toBe(3);
    });

    it("constructs correct URLs for methods", async () => {
      process.env.AGENTCORE_SOURCES = "boto3_data_plane";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_BOTO3_HTML);

      const { getIndex } = await import("../src/doc-index.js");
      const entries = await getIndex();

      const invokeEntry = entries.find(e => e.title === "invoke_harness");
      expect(invokeEntry?.url).toContain("bedrock-agentcore/client/invoke_harness.html");
    });
  });

  describe("FAQ parser", () => {
    // The FAQ parser expects markdown-like content with ### headings ending in ?
    // The real FAQ page is fetched as HTML — the parser uses regex on raw content
    const MOCK_FAQ_MARKDOWN = `## General

### What is Amazon Bedrock AgentCore?

AgentCore is a platform to build, connect, and optimize AI agents at scale.

### Which regions is AgentCore available in?

AgentCore is available in fifteen AWS Regions.

## Runtime

### What is AgentCore Runtime?

AgentCore Runtime is a secure, serverless runtime for deploying agents.
`;

    it("extracts questions and answers", async () => {
      process.env.AGENTCORE_SOURCES = "faq";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_FAQ_MARKDOWN);

      const { getIndex, getComponents } = await import("../src/doc-index.js");
      const entries = await getIndex();
      const components = await getComponents();

      expect(entries.length).toBe(3);
      expect(entries[0].title).toBe("What is Amazon Bedrock AgentCore?");
      expect(entries[0].description).toContain("platform to build");

      expect(components.length).toBe(1);
      expect(components[0].name).toBe("faq");
      expect(components[0].subPages.length).toBe(3);
    });

    it("tags FAQ entries with relevant component names", async () => {
      process.env.AGENTCORE_SOURCES = "faq";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_FAQ_MARKDOWN);

      const { getIndex } = await import("../src/doc-index.js");
      const entries = await getIndex();

      const runtimeFaq = entries.find(e => e.title.includes("Runtime"));
      expect(runtimeFaq).toBeDefined();
      expect(runtimeFaq!.tags).toContain("runtime");
    });

    // The live FAQ page renders Q&A from a client-side data blob embedded as
    // <script type="application/json">; the visible <h2>/<h3> tags are empty
    // toggle-button shells with no text. A mock built from markdown-style
    // headings (like the one above) can't catch a regression here — this
    // fixture is a trimmed capture of the real page's actual HTML/JSON shape.
    it("extracts questions from the real page's embedded JSON (not markdown headings)", async () => {
      process.env.AGENTCORE_SOURCES = "faq";
      vi.mocked(fetchRawUrl).mockResolvedValue(readFixture("faq-real.html"));

      const { getIndex } = await import("../src/doc-index.js");
      const entries = await getIndex();

      expect(entries.length).toBe(3);
      expect(entries[0].title).toBe("What is Amazon Bedrock AgentCore?");
      expect(entries[0].description).toContain("platform to build, connect, and optimize");
      // The single generic-fallback entry must NOT fire when JSON parses fine.
      expect(entries.every(e => e.title !== "AgentCore FAQs")).toBe(true);
    });
  });

  describe("GitHub README parser", () => {
    it("extracts links and creates SDK entry", async () => {
      process.env.AGENTCORE_SOURCES = "sdk";
      vi.mocked(fetchRawUrl).mockResolvedValue(MOCK_GITHUB_README);

      const { getIndex, getComponents } = await import("../src/doc-index.js");
      const entries = await getIndex();
      const components = await getComponents();

      // Should have the main SDK entry plus extracted links
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const sdkEntry = entries.find(e => e.title.includes("AgentCore Python SDK"));
      expect(sdkEntry).toBeDefined();
      expect(sdkEntry?.tags).toContain("sdk");

      expect(components.length).toBe(1);
      expect(components[0].name).toBe("sdk");
    });
  });

  describe("error handling", () => {
    it("returns empty results when fetch fails", async () => {
      process.env.AGENTCORE_SOURCES = "docs";
      vi.mocked(fetchRawUrl).mockRejectedValue(new Error("Network error"));

      const { getIndex, getComponents } = await import("../src/doc-index.js");
      const entries = await getIndex();
      const components = await getComponents();

      expect(entries).toEqual([]);
      expect(components).toEqual([]);
    });
  });
});
