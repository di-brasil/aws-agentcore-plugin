import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * End-to-end tests for the MCP server.
 * Spawns the actual server process and communicates via JSON-RPC over stdio.
 * No LLM calls — tests the MCP protocol contract directly.
 */

const SERVER_PATH = path.resolve(__dirname, "../dist/index.js");

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

class McpTestClient {
  private process: ChildProcess;
  private buffer = "";
  private responseQueue: Array<(response: JsonRpcResponse) => void> = [];
  private nextId = 1;

  constructor(env?: Record<string, string>) {
    this.process = spawn("node", [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.process.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            const resolver = this.responseQueue.shift();
            if (resolver) resolver(parsed);
          } catch { /* ignore non-JSON lines */ }
        }
      }
    });
  }

  async send(method: string, params: any = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response to ${method}`)), 25000);
      this.responseQueue.push((response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      this.process.stdin!.write(request + "\n");
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    return this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
  }

  async listTools(): Promise<JsonRpcResponse> {
    return this.send("tools/list", {});
  }

  async callTool(name: string, args: any): Promise<JsonRpcResponse> {
    return this.send("tools/call", { name, arguments: args });
  }

  close() {
    this.process.kill();
  }
}

describe("MCP Server E2E", () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient({ AGENTCORE_SOURCES: "docs,faq" });
    await client.initialize();
  });

  afterAll(() => {
    client.close();
  });

  describe("initialize", () => {
    it("responds with server info", async () => {
      const freshClient = new McpTestClient();
      const response = await freshClient.initialize();
      expect(response.result).toBeDefined();
      expect(response.result.serverInfo.name).toBe("agentcore-assistant");
      expect(response.result.serverInfo.version).toBe("4.4.0");
      freshClient.close();
    });
  });

  describe("tools/list", () => {
    it("returns exactly 3 tools", async () => {
      const response = await client.listTools();
      expect(response.result.tools.length).toBe(3);
    });

    it("has list_agentcore_components tool", async () => {
      const response = await client.listTools();
      const tool = response.result.tools.find((t: any) => t.name === "list_agentcore_components");
      expect(tool).toBeDefined();
      expect(tool.description).toContain("overview");
      expect(tool.inputSchema.properties.source).toBeDefined();
      expect(tool.inputSchema.properties.component).toBeDefined();
    });

    it("has search_agentcore_docs tool", async () => {
      const response = await client.listTools();
      const tool = response.result.tools.find((t: any) => t.name === "search_agentcore_docs");
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.query).toBeDefined();
      expect(tool.inputSchema.properties.source).toBeDefined();
      expect(tool.inputSchema.properties.max_results).toBeDefined();
      expect(tool.inputSchema.required).toContain("query");
    });

    it("has fetch_agentcore_doc tool", async () => {
      const response = await client.listTools();
      const tool = response.result.tools.find((t: any) => t.name === "fetch_agentcore_doc");
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.url).toBeDefined();
      expect(tool.inputSchema.required).toContain("url");
    });
  });

  describe("list_agentcore_components", () => {
    it("returns components from enabled sources", async () => {
      const response = await client.callTool("list_agentcore_components", {});
      const text = response.result.content[0].text;
      expect(text).toContain("Amazon Bedrock AgentCore");
      expect(text).toContain("pages indexed");
      expect(text).toContain("Active sources:");
    });

    it("filters by source", async () => {
      const response = await client.callTool("list_agentcore_components", { source: "faq" });
      const text = response.result.content[0].text;
      expect(text.toLowerCase()).toContain("faq");
    });

    it("filters by component name", async () => {
      const response = await client.callTool("list_agentcore_components", { component: "memory" });
      const text = response.result.content[0].text;
      expect(text.toLowerCase()).toContain("memory");
    });

    it("returns error for unknown component", async () => {
      const response = await client.callTool("list_agentcore_components", { component: "nonexistent_xyz" });
      const text = response.result.content[0].text;
      expect(text).toContain("No components matching");
    });
  });

  describe("search_agentcore_docs", () => {
    it("returns results for valid query", async () => {
      const response = await client.callTool("search_agentcore_docs", { query: "harness tools" });
      const text = response.result.content[0].text;
      expect(text).toContain("###");
      expect(text).toContain("**URL:**");
    });

    it("returns no-results message for garbage query", async () => {
      const response = await client.callTool("search_agentcore_docs", { query: "xyznonexistent123abc" });
      const text = response.result.content[0].text;
      expect(text).toContain("No results");
    });

    it("respects max_results parameter", async () => {
      const response = await client.callTool("search_agentcore_docs", { query: "agent", max_results: 2 });
      const text = response.result.content[0].text;
      const headings = text.match(/^### /gm) || [];
      expect(headings.length).toBeLessThanOrEqual(2);
    });

    it("filters by source", async () => {
      const response = await client.callTool("search_agentcore_docs", { query: "pricing", source: "faq" });
      const text = response.result.content[0].text;
      // Should find FAQ about pricing
      expect(text.toLowerCase()).toContain("faq");
    });
  });

  describe("fetch_agentcore_doc", () => {
    it("fetches and returns page content", async () => {
      const response = await client.callTool("fetch_agentcore_doc", {
        url: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html",
      });
      const text = response.result.content[0].text;
      expect(text).toContain("**Source:**");
      expect(text).toContain("harness");
      expect(text.length).toBeGreaterThan(500);
    });

    it("refuses a URL outside the documentation hosts", async () => {
      const response = await client.callTool("fetch_agentcore_doc", {
        url: "https://this-domain-does-not-exist-xyz123456.invalid/page.html",
      });
      const text = response.result.content[0].text;
      expect(text).toContain("Refused to fetch");
      expect(text).toContain("docs.aws.amazon.com");
    });

    it("pages past the 20000-character cap with offset", async () => {
      // The CDK Java reference is ~190k characters. Before offset existed, the
      // later 89% of the page was unreachable: CfnGateway sorts after the cut,
      // these are single-page sources so there is no narrower page to ask for,
      // and construct names are not indexed for search.
      const url = "https://docs.aws.amazon.com/cdk/api/v2/java/software/amazon/awscdk/cfnpropertymixins/services/bedrockagentcore/package-summary.html";

      const first = await client.callTool("fetch_agentcore_doc", { url });
      const firstText = first.result.content[0].text;
      expect(firstText).toContain("call again with offset=");

      const nextOffset = Number(firstText.match(/offset=(\d+)/)![1]);
      expect(nextOffset).toBe(20000);

      const second = await client.callTool("fetch_agentcore_doc", { url, offset: nextOffset });
      const secondText = second.result.content[0].text;
      expect(secondText).toContain("Resumed at character 20000");
      // Genuinely new content, not a repeat of the first window.
      expect(secondText).not.toContain("CfnApiKeyCredentialProviderMixinProps");
    });

    it("clamps an offset past the end instead of erroring", async () => {
      const response = await client.callTool("fetch_agentcore_doc", {
        url: "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html",
        offset: 99_000_000,
      });
      const text = response.result.content[0].text;
      expect(text).toContain("**Source:**");
      expect(text).not.toContain("call again with offset=");
    });
  });
});

describe("search_agentcore_docs hydration", () => {
  it("hydrates 3 distinct URLs, not the same page 3 times", async () => {
    // Every FAQ question shares the FAQ page URL, so ranking alone used to
    // hydrate one page 3 times and print 3 identical bodies under 3 headings.
    const faqClient = new McpTestClient({ AGENTCORE_SOURCES: "faq" });
    await faqClient.initialize();

    const response = await faqClient.callTool("search_agentcore_docs", {
      query: "charged pricing cost",
      source: "faq",
      max_results: 5,
    });
    const text = response.result.content[0].text;

    // One hydrated block, because the FAQ source only has one distinct URL.
    const hydratedBlocks = text.match(/^\*\*URL:\*\*/gm) || [];
    expect(hydratedBlocks.length).toBe(1);
    // The rest still reach the model as links.
    expect(text).toContain("**More results:**");

    faqClient.close();
  });
});

describe("MCP Server source filtering", () => {
  it("respects AGENTCORE_SOURCES env var", async () => {
    const filteredClient = new McpTestClient({ AGENTCORE_SOURCES: "faq" });
    await filteredClient.initialize();

    const response = await filteredClient.callTool("list_agentcore_components", {});
    const text = response.result.content[0].text;
    // With only FAQ source, should have limited pages and mention faq
    expect(text).toContain("faq");
    expect(text).toContain("1 sources");
    // Should not have harness/runtime docs content
    expect(text).not.toContain("AgentCore harness");

    filteredClient.close();
  });
});
