import { describe, it, expect } from "vitest";
import { isAllowedDocUrl, getAllowedHosts } from "../src/sources.js";

// fetch_agentcore_doc used to fetch any URL and return the body through the
// trusted tool-result channel. These pin the boundary.

describe("isAllowedDocUrl", () => {
  it("allows the documentation hosts the sources actually use", () => {
    for (const url of [
      "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html",
      "https://aws.amazon.com/bedrock/agentcore/faqs/",
      "https://raw.githubusercontent.com/aws/bedrock-agentcore-sdk-python/main/README.md",
      "https://github.com/aws/bedrock-agentcore-sdk-python",
      "https://pkg.go.dev/github.com/aws/aws-cdk-go/awscdk/v2@v2.260.0/awsbedrockagentcore",
    ]) {
      expect(isAllowedDocUrl(url), url).toBe(true);
    }
  });

  it("refuses off-corpus hosts", () => {
    expect(isAllowedDocUrl("https://example.com/")).toBe(false);
  });

  it("refuses suffix-collision lookalikes", () => {
    // Exact hostname match, not endsWith — this is the bug an endsWith
    // implementation would ship.
    expect(isAllowedDocUrl("https://docs.aws.amazon.com.attacker.net/x")).toBe(false);
    expect(isAllowedDocUrl("https://notaws.amazon.com/x")).toBe(false);
  });

  it("refuses non-https schemes, including internal hosts and file reads", () => {
    expect(isAllowedDocUrl("http://docs.aws.amazon.com/x")).toBe(false);
    expect(isAllowedDocUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedDocUrl("http://localhost:8080/admin")).toBe(false);
    expect(isAllowedDocUrl("file:///etc/passwd")).toBe(false);
  });

  it("refuses garbage instead of throwing", () => {
    expect(isAllowedDocUrl("not a url")).toBe(false);
    expect(isAllowedDocUrl("")).toBe(false);
  });

  it("derives hosts from the source list so the two can't drift", () => {
    const hosts = getAllowedHosts();
    expect(hosts).toContain("docs.aws.amazon.com");
    expect(hosts).toContain("pkg.go.dev");
    // Only real doc hosts, nothing hand-added.
    expect(hosts.length).toBe(5);
  });
});
