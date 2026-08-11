import { describe, it, expect } from "vitest";
import { searchEntries, type DocEntry } from "../src/doc-index.js";

// Stopword filtering. Before it, a query's stopwords scored the same +10 title
// hit as its one distinctive term, so generic reference pages outranked the
// exact match the user named.

function entry(title: string, over: Partial<DocEntry> = {}): DocEntry {
  return {
    url: over.url ?? `https://docs.aws.amazon.com/${title.replace(/\s+/g, "-").toLowerCase()}.html`,
    title,
    description: over.description ?? "",
    sourceId: over.sourceId ?? "docs",
    component: over.component ?? "agentcore",
    tags: over.tags ?? [],
  };
}

describe("searchEntries stopword handling", () => {
  it("ranks the named operation above generic 'Common Parameters' pages", () => {
    const entries = [
      entry("Common Parameters", { sourceId: "api_data_plane" }),
      entry("Common Parameters", { sourceId: "api_control_plane", url: "https://docs.aws.amazon.com/cp/CommonParameters.html" }),
      entry("CreateGateway", { component: "gateway", description: "Creates a gateway for Amazon Bedrock Agent." }),
    ];

    const results = searchEntries(entries, "CreateGateway parameters");

    expect(results[0].title).toBe("CreateGateway");
  });

  it("drops question stopwords so real pages beat FAQ 'How does...' titles", () => {
    const entries = [
      entry("Create and deploy your agent", { component: "runtime" }),
      entry("How does Strands Agents integrate with AgentCore?", { sourceId: "faq", component: "faq" }),
      entry("How does AgentCore Gateway help with tool selection?", { sourceId: "faq", component: "faq" }),
    ];

    const results = searchEntries(entries, "how do I deploy an agent");

    expect(results[0].title).toBe("Create and deploy your agent");
  });

  it("falls back to raw terms when the query is nothing but stopwords", () => {
    // "what is the overview" is all stopwords. Returning nothing would be worse
    // than returning a best-effort match.
    const entries = [entry("Overview")];

    const results = searchEntries(entries, "what is the overview");

    expect(results.length).toBe(1);
  });

  it("still returns nothing for a genuine non-match", () => {
    expect(searchEntries([entry("Memory strategies")], "xyznonexistent")).toEqual([]);
  });
});
