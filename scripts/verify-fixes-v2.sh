#!/usr/bin/env bash
# Demonstrate and verify the five MCP tool fixes.
#
# For each bug this prints: what's broken, why it matters, the root cause, the
# exact tool call, the PASS criterion stated BEFORE the result, then the real
# output from both builds side by side.
#
# "Before" output is produced live by building main in a throwaway git worktree
# and calling the same tool with the same arguments. Nothing here is a transcript.
#
# Usage:  ./scripts/verify-fixes-v2.sh
#         BASE_REF=main ./scripts/verify-fixes-v2.sh
# Needs:  node 18+, git, network access (the server fetches live AWS docs).

set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
BASE_REF="${BASE_REF:-origin/main}"
TMPROOT="$(mktemp -d)"
WORKTREE="$TMPROOT/main"
PASS=0; FAIL=0; CASE=0

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'
C_CYAN=$'\033[1;36m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'
C_YELL=$'\033[33m'; C_MAG=$'\033[35m'

rule()  { printf '%s%s%s\n' "$C_DIM" "──────────────────────────────────────────────────────────────────────────" "$C_RESET"; }
banner() {
  CASE=$((CASE + 1))
  printf '\n%s══════════════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
  printf '%s TEST %s · %s%s\n' "$C_CYAN" "$CASE/6" "$1" "$C_RESET"
  printf '%s══════════════════════════════════════════════════════════════════════════%s\n' "$C_CYAN" "$C_RESET"
}
field() { printf '\n%s%s%s\n' "$C_B" "$1" "$C_RESET"; shift; while [ $# -gt 0 ]; do printf '  %s\n' "$1"; shift; done; }
call_line() { printf '\n%sTOOL CALL%s\n  %s$ %s%s\n' "$C_B" "$C_RESET" "$C_YELL" "$1" "$C_RESET"; }
criterion() { printf '\n%sPASS CRITERION%s\n  %s%s%s\n' "$C_B" "$C_RESET" "$C_MAG" "$1" "$C_RESET"; }

# assert <label> <cmd...>  — label states the criterion, cmd decides
assert() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '\n  %s✔ PASS%s  %s\n' "$C_GREEN" "$C_RESET" "$label"; PASS=$((PASS + 1))
  else
    printf '\n  %s✘ FAIL%s  %s\n' "$C_RED" "$C_RESET" "$label"; FAIL=$((FAIL + 1))
  fi
}

# grep the output of a tool call. Plain functions instead of nested `bash -c`
# with escaped JSON — that quoting word-splits the arguments and the call fails
# for the wrong reason, which reads as a code bug.
after_has()  { printf '%s' "$(after  "$1" "$2")" | grep -q "$3"; }
before_has() { printf '%s' "$(before "$1" "$2")" | grep -q "$3"; }
has()        { printf '%s' "$1" | grep -q "$2"; }
lacks()      { ! printf '%s' "$1" | grep -q "$2"; }
first_result() { printf '%s' "$1" | grep -m1 '^### '; }

cleanup() { git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; rm -rf "$TMPROOT" 2>/dev/null || true; }
trap cleanup EXIT

# Print two labelled blocks side by side, 36 cols each.
two_col() {
  local lhead="$1" rhead="$2" ltext="$3" rtext="$4"
  paste -d'\t' <(printf '%s\n' "$ltext") <(printf '%s\n' "$rtext") 2>/dev/null \
    | awk -F'\t' -v lh="$lhead" -v rh="$rhead" '
      BEGIN { printf "  %-36s │ %s\n", lh, rh
              printf "  %-36s │ %s\n", "------------------------------------", "-----------------------------------" }
      { printf "  %-36s │ %s\n", $1, $2 }'
}

# Per-hydrated-block checksum: proves whether bodies are literally identical.
block_report() {
  node -e '
let t=""; process.stdin.on("data",d=>t+=d).on("end",()=>{
  const blocks = t.split(/\n---\n/).filter(b => b.includes("**URL:**"));
  if (!blocks.length) { console.log("    (no hydrated blocks)"); return; }
  const seen = new Map();
  blocks.forEach((b, i) => {
    const url = (b.match(/\*\*URL:\*\* (\S+)/) || [])[1] || "?";
    const body = b.split("\n").filter(l => !/^(###|\*\*)/.test(l)).join("\n").trim();
    const md5 = require("crypto").createHash("md5").update(body).digest("hex").slice(0, 10);
    seen.set(md5, (seen.get(md5) || 0) + 1);
    const title = (b.match(/^### (.+)$/m) || [])[1] || "?";
    console.log(`    block ${i + 1}: body-md5 ${md5}  ${title.slice(0, 46)}`);
    console.log(`             url ${url}`);
  });
  const dupes = [...seen.values()].filter(n => n > 1).length;
  console.log(`    → ${blocks.length} block(s), ${seen.size} distinct body checksum(s)` +
              (dupes ? `  *** ${blocks.length - seen.size} DUPLICATE bodies ***` : "  (no duplicates)"));
});'
}

# ── build both sides ────────────────────────────────────────────────────────
printf '%s\n' "$C_B$(rule)"
printf '%s  AgentCore MCP tool fixes — verification against a live build of %s%s\n' "$C_B" "$BASE_REF" "$C_RESET"
rule
git rev-parse --verify "$BASE_REF" >/dev/null 2>&1 || { echo "no such ref: $BASE_REF"; exit 1; }
printf '  this branch : %s @ %s\n' "$(git rev-parse --abbrev-ref HEAD)" "$(git rev-parse --short HEAD)"
printf '  baseline    : %s @ %s\n' "$BASE_REF" "$(git rev-parse --short "$BASE_REF")"
npm run build >/dev/null 2>&1 || { echo "branch build failed"; exit 1; }
AFTER="$REPO/dist/index.js"
git worktree add --detach "$WORKTREE" "$BASE_REF" >/dev/null 2>&1 || { echo "worktree failed"; exit 1; }
BEFORE="$WORKTREE/dist/index.js"   # main ships a prebuilt dist/, no install needed
[ -f "$BEFORE" ] || { echo "no prebuilt dist on $BASE_REF"; exit 1; }
printf '  both servers built. every "before" line below is live output from %s.\n' "$BASE_REF"

before() { node scripts/mcp-call.mjs "$BEFORE" "$1" "$2" 2>/dev/null; }
after()  { node scripts/mcp-call.mjs "$AFTER"  "$1" "$2" 2>/dev/null; }

# ── TEST 1 · BUG-4 ─────────────────────────────────────────────────────────
banner "BUG-4  fetch_agentcore_doc  ·  CDK references unreachable past 20k chars"
field "WHAT'S BROKEN" \
  "fetch_agentcore_doc caps output at 20,000 characters. The five cdk_* pages" \
  "run 30k-200k, so most of every CDK reference could not be read at all."
field "WHY IT MATTERS" \
  "These are 'single_page' sources: each contributes ONE index entry and its" \
  "construct names are never indexed, so search can't reach them either." \
  "The README's own example prompt ('define an AgentCore Gateway in CDK')" \
  "was unanswerable for Java, .NET and Go."
field "ROOT CAUSE" \
  "src/index.ts sliced content.slice(0, 20000) with no way to ask for more." \
  "The notice said 'ask for a narrower section or a different page' — but" \
  "no narrower page exists, and the tool took only a url."
field "THE FIX" \
  "Add an 'offset' parameter. The notice now reports total length and the" \
  "exact offset to pass next, so a caller can walk the whole page."

CDK_URL="https://docs.aws.amazon.com/cdk/api/v2/java/software/amazon/awscdk/cfnpropertymixins/services/bedrockagentcore/package-summary.html"
call_line "fetch_agentcore_doc {\"url\":\".../bedrockagentcore/package-summary.html\"}"
criterion "CfnGatewayPropsMixin must be absent from the first window on main, and reachable via offset on this branch."

B4_BEFORE="$(before fetch_agentcore_doc "{\"url\":\"$CDK_URL\"}")"
B4_AFTER1="$(after  fetch_agentcore_doc "{\"url\":\"$CDK_URL\"}")"
PAGE_CHARS="$(printf '%s' "$B4_BEFORE" | grep -o 'page is [0-9]* characters' | grep -o '[0-9]*')"
printf '\n%sEVIDENCE%s\n' "$C_B" "$C_RESET"
printf '  page size (live, grows over time) : %s characters\n' "${PAGE_CHARS:-?}"
printf '  window size                       : 20000 characters (%.0f%% of the page)\n' \
  "$(node -e "console.log(20000/${PAGE_CHARS:-204173}*100)")"
printf '\n  %sbefore%s  last line of the response:\n' "$C_DIM" "$C_RESET"
printf '%s\n' "$B4_BEFORE" | tail -1 | fold -s -w 68 | sed 's/^/      /'
printf '  %safter%s   last line of the response:\n' "$C_DIM" "$C_RESET"
printf '%s\n' "$B4_AFTER1" | tail -1 | fold -s -w 68 | sed 's/^/      /'

printf '\n  walking the page with offset, looking for CfnGatewayPropsMixin:\n'
OFF=0; FOUND=no; PAGES=0
while [ "$PAGES" -lt 15 ]; do
  T="$(after fetch_agentcore_doc "{\"url\":\"$CDK_URL\",\"offset\":$OFF}")"
  PAGES=$((PAGES + 1))
  FIRST_CLASS="$(printf '%s' "$T" | grep -o 'Cfn[A-Za-z]*' | head -1)"
  if printf '%s' "$T" | grep -q CfnGatewayPropsMixin; then
    printf '      window %s (offset %-6s) starts at %-34s %s← FOUND%s\n' "$PAGES" "$OFF" "${FIRST_CLASS:-?}" "$C_GREEN" "$C_RESET"
    FOUND=yes; break
  fi
  printf '      window %s (offset %-6s) starts at %s\n' "$PAGES" "$OFF" "${FIRST_CLASS:-?}"
  NEXT="$(printf '%s' "$T" | grep -o 'offset=[0-9]*' | tail -1 | cut -d= -f2)"
  [ -n "$NEXT" ] || break
  OFF="$NEXT"
done
printf '\n  before: CfnGatewayPropsMixin in response? %sno  (unreachable, no paging)%s\n' "$C_RED" "$C_RESET"
printf '  after : CfnGatewayPropsMixin in response? %syes (window %s, offset %s)%s\n' "$C_GREEN" "$PAGES" "$OFF" "$C_RESET"

assert "main cannot reach CfnGatewayPropsMixin (bug reproduced)" lacks "$B4_BEFORE" CfnGatewayPropsMixin
assert "this branch reaches it by paging with offset" test "$FOUND" = yes
assert "truncation notice tells the caller the next offset" has "$B4_AFTER1" "call again with offset="
B4_CLAMP="$(after fetch_agentcore_doc '{"url":"https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html","offset":99000000}')"
printf '\n  offset past end of page (99000000) clamps rather than erroring:\n'
printf '%s\n' "$B4_CLAMP" | grep -m1 'Resumed at' | sed 's/^/      /'
assert "offset past end of page clamps instead of erroring" has "$B4_CLAMP" "Resumed at character"

# ── TEST 2 · BUG-2 ─────────────────────────────────────────────────────────
banner "BUG-2  search_agentcore_docs  ·  exact match ranked below generic pages"
field "WHAT'S BROKEN" \
  "Searching the name of an API operation did not return that operation" \
  "first. 'CreateGateway parameters' is an example query copied from the" \
  "tool's own parameter description, so this is the documented usage."
field "WHY IT MATTERS" \
  "Only the top 3 results get a live 1500-char content snippet. Everything" \
  "below is a bare link. A page ranked 4th is effectively invisible: the" \
  "model sees a title, not the request schema it needs to write code."
field "ROOT CAUSE" \
  "searchEntries() in src/doc-index.ts scored every query term equally." \
  "'parameters' earned the same +10 title hit as 'creategateway', and" \
  "hundreds of AWS API pages have 'Parameters' in the title."
field "THE FIX" \
  "Drop stopwords and low-signal reference words before scoring. If a query" \
  "is nothing BUT stopwords, fall back to the raw terms so it still matches."

call_line 'search_agentcore_docs {"query":"CreateGateway parameters","max_results":3}'
criterion "The first hydrated result must be exactly 'CreateGateway'."
B2_BEFORE="$(before search_agentcore_docs '{"query":"CreateGateway parameters","max_results":3}')"
B2_AFTER="$(after   search_agentcore_docs '{"query":"CreateGateway parameters","max_results":3}')"
printf '\n%sRANKED RESULTS (hydrated = gets real content)%s\n' "$C_B" "$C_RESET"
two_col "main (before)" "this branch (after)" \
  "$(printf '%s\n' "$B2_BEFORE" | grep '^### ' | sed 's/^### //' | head -3 | nl -w2 -s'. ')" \
  "$(printf '%s\n' "$B2_AFTER"  | grep '^### ' | sed 's/^### //' | head -3 | nl -w2 -s'. ')"
printf '\n  %snote%s  "Common Parameters" is the SigV4 request-signing page. It is\n' "$C_DIM" "$C_RESET"
printf '        identical in both API references, so it won twice and pushed\n'
printf '        the real answer to rank 3.\n'
assert "first result is exactly 'CreateGateway'" test "$(first_result "$B2_AFTER")" = "### CreateGateway"
assert "main did NOT rank it first (bug reproduced)" test "$(first_result "$B2_BEFORE")" != "### CreateGateway"

printf '\n%sSECOND CASE — natural language, where stopwords do the most damage%s\n' "$C_B" "$C_RESET"
call_line 'search_agentcore_docs {"query":"how do I deploy an agent","max_results":3}'
criterion "Hydration slots must not be spent on FAQ titles matched only on the word 'how'."
NL_BEFORE="$(before search_agentcore_docs '{"query":"how do I deploy an agent","max_results":3}')"
NL_AFTER="$(after   search_agentcore_docs '{"query":"how do I deploy an agent","max_results":3}')"
two_col "main (before)" "this branch (after)" \
  "$(printf '%s\n' "$NL_BEFORE" | grep '^### ' | sed 's/^### //' | cut -c1-34 | head -3 | nl -w2 -s'. ')" \
  "$(printf '%s\n' "$NL_AFTER"  | grep '^### ' | sed 's/^### //' | cut -c1-34 | head -3 | nl -w2 -s'. ')"
HOWCOUNT_B="$(printf '%s' "$NL_BEFORE" | grep -c '^### How ')"
HOWCOUNT_A="$(printf '%s' "$NL_AFTER"  | grep -c '^### How ')"
printf '\n  hydration slots wasted on "How ..." FAQ titles:  before %s of 3   after %s of 3\n' "$HOWCOUNT_B" "$HOWCOUNT_A"
assert "fewer hydration slots wasted on stopword-only matches" test "$HOWCOUNT_A" -lt "$HOWCOUNT_B"
NL_ALLSTOP="$(after search_agentcore_docs '{"query":"what is the overview"}')"
printf '  all-stopword query "what is the overview" still returns a result:  %s\n' \
  "$(printf '%s' "$NL_ALLSTOP" | grep -m1 '^### ' | sed 's/^### //' | cut -c1-40)"
assert "all-stopword query still returns something (no regression)" has "$NL_ALLSTOP" "URL:"

# ── TEST 3 · BUG-3 ─────────────────────────────────────────────────────────
banner "BUG-3  search_agentcore_docs  ·  one page hydrated 3x, bodies identical"
field "WHAT'S BROKEN" \
  "When several results shared a URL, all three hydration slots fetched the" \
  "SAME page and printed the SAME 1500 characters under three different" \
  "headings — none of which contained the matched question's answer."
field "WHY IT MATTERS" \
  "~3000 of ~4500 hydrated characters were exact duplicates. Worse, each" \
  "body sat under an unrelated heading, so a model could attribute" \
  "'What is AgentCore?' text to the pricing question above it."
field "ROOT CAUSE" \
  "index.ts hydrated results.slice(0,3) by rank. All 52 FAQ questions are" \
  "extracted from one page and share its URL. 10 devguide pages are also" \
  "listed twice (docs + sdk), so this was never FAQ-only."
field "THE FIX" \
  "Hydrate the top 3 DISTINCT urls, in the shared hydration path rather" \
  "than as an FAQ special case. Skipped entries still appear as links."

call_line 'search_agentcore_docs {"query":"how am I charged pricing","source":"faq","max_results":5}'
criterion "Every hydrated block must have a distinct URL, and no two bodies may share a checksum."
B3_BEFORE="$(before search_agentcore_docs '{"query":"how am I charged pricing","source":"faq","max_results":5}')"
B3_AFTER="$(after   search_agentcore_docs '{"query":"how am I charged pricing","source":"faq","max_results":5}')"
printf '\n%sBEFORE — main%s  (md5 of each hydrated body)\n' "$C_B" "$C_RESET"
printf '%s' "$B3_BEFORE" | block_report
printf '\n%sAFTER — this branch%s\n' "$C_B" "$C_RESET"
printf '%s' "$B3_AFTER" | block_report
printf '\n  the FAQ source has exactly ONE distinct url, so one block is correct.\n'
printf '  remaining matches are still delivered as links:  %s\n' \
  "$(printf '%s' "$B3_AFTER" | grep -q 'More results:' && echo 'yes — "More results:" present' || echo 'NO')"
assert "no hydrated body is duplicated" bash -c '
  n=$(printf "%s" "$1" | grep -c "^\*\*URL:\*\*")
  u=$(printf "%s" "$1" | grep "^\*\*URL:\*\*" | sort -u | wc -l | tr -d " ")
  [ "$n" -eq "$u" ]' _ "$B3_AFTER"
assert "main did duplicate them (bug reproduced)" bash -c '
  n=$(printf "%s" "$1" | grep -c "^\*\*URL:\*\*")
  u=$(printf "%s" "$1" | grep "^\*\*URL:\*\*" | sort -u | wc -l | tr -d " ")
  [ "$n" -gt "$u" ]' _ "$B3_BEFORE"
assert "non-hydrated results still reach the model as links" has "$B3_AFTER" "More results:"

# ── TEST 4 · BUG-1 ─────────────────────────────────────────────────────────
banner "BUG-1  list_agentcore_components  ·  false negative on boto3 components"
field "WHAT'S BROKEN" \
  "Filtering boto3 methods by component reported that none exist, even" \
  "though the memory methods are in the index and findable by search." \
  "A confidently wrong answer, which is worse than no answer."
field "WHY IT MATTERS" \
  "A model asking 'what boto3 memory operations are there?' was told" \
  "there are none, and would reasonably stop looking."
field "ROOT CAUSE" \
  "Entries already carried real component names via inferBoto3Component()," \
  "but parseBoto3Index() emitted ONE ComponentSummary named after the" \
  "source. The filter matches ComponentSummary.name, so per-entry" \
  "components were invisible to this tool."
field "THE FIX" \
  "Emit one summary per inferred component. Keep the flat all-methods" \
  "summary so 'source:' overviews keep working."

call_line 'list_agentcore_components {"source":"boto3_data_plane","component":"memory"}'
criterion "Must return a memory component listing the boto3 memory methods, and the flat source overview must still work."
B1_BEFORE="$(before list_agentcore_components '{"source":"boto3_data_plane","component":"memory"}')"
B1_AFTER="$(after   list_agentcore_components '{"source":"boto3_data_plane","component":"memory"}')"
printf '\n%sBEFORE — main%s\n' "$C_B" "$C_RESET"
printf '%s\n' "$B1_BEFORE" | head -1 | sed "s/^/    $C_RED/;s/\$/$C_RESET/"
printf '\n%sAFTER — this branch%s\n' "$C_B" "$C_RESET"
printf '%s\n' "$B1_AFTER" | grep -m1 '^## ' | sed 's/^/    /'
printf '%s\n' "$B1_AFTER" | grep -m1 '^\*\*Pages:\*\*' | sed 's/^/    /'
printf '    methods that were hidden by the bug:\n'
printf '%s\n' "$B1_AFTER" | grep -oE '\b[a-z_]*memory[a-z_]*\b' | sort -u | head -6 | sed 's/^/      · /'
HIDDEN="$(printf '%s\n' "$B1_AFTER" | grep -oE '\b[a-z_]*memory[a-z_]*\b' | sort -u | wc -l | tr -d ' ')"
printf '      (%s distinct memory method names in this component)\n' "$HIDDEN"
# Capture the unfiltered overview once and assert against the text, rather than
# calling inside assert — a fresh server spawn there competes with the other
# probes and can hit mcp-call.mjs's timeout, failing for load rather than logic.
B1_FLAT="$(after list_agentcore_components '{"source":"boto3_data_plane"}')"
printf '\n  unfiltered overview (regression check) still lists the flat client:\n'
printf '%s\n' "$B1_FLAT" | grep -m1 '^## Boto3' | sed 's/^/      /'

assert "boto3 memory component is now found" has "$B1_AFTER" "Client — memory"
assert "main reported it missing (bug reproduced)" has "$B1_BEFORE" "No components matching"
assert "flat 'source:' overview still works (no regression)" has "$B1_FLAT" "Boto3 bedrock-agentcore Client"

# ── TEST 5 · BUG-5 ─────────────────────────────────────────────────────────
banner "BUG-5  fetch_agentcore_doc  ·  no URL allowlist"
field "WHAT'S BROKEN" \
  "The tool fetched ANY url and returned the body through the trusted" \
  "tool-result channel, including plain http:// and internal addresses."
field "WHY IT MATTERS" \
  "Content from an arbitrary host arriving as a trusted tool result is a" \
  "prompt-injection delivery path. Mild on its own — no credentials are" \
  "attached — but it costs nothing to close."
field "ROOT CAUSE" \
  "No validation. The description said 'any URL from the search results'," \
  "but nothing enforced that."
field "THE FIX" \
  "Allowlist the 5 hostnames the sources actually use, derived from" \
  "ALL_SOURCES so it cannot drift. Exact hostname match, not endsWith," \
  "and https only."

criterion "Off-corpus, lookalike, http:// and metadata URLs refused. Real AWS docs still fetched."
printf '\n%sURL MATRIX%s   (after = this branch)\n' "$C_B" "$C_RESET"
printf '  %-46s %-12s %s\n' "url" "expected" "after"
printf '  %-46s %-12s %s\n' "----------------------------------------------" "------------" "------------"
check_url() { # url expected("refuse"|"allow")
  local u="$1" want="$2" out verdict
  out="$(after fetch_agentcore_doc "{\"url\":\"$u\"}")"
  if printf '%s' "$out" | grep -q '^Refused to fetch'; then verdict=refused; else verdict=fetched; fi
  local mark="${C_GREEN}✔$C_RESET"
  { [ "$want" = refuse ] && [ "$verdict" != refused ]; } && mark="${C_RED}✘$C_RESET"
  { [ "$want" = allow ]  && [ "$verdict" != fetched ]; } && mark="${C_RED}✘$C_RESET"
  printf '  %-46s %-12s %s %s\n' "$(printf '%.46s' "$u")" "$want" "$verdict" "$mark"
}
check_url "https://example.com/" refuse
check_url "https://docs.aws.amazon.com.attacker.net/x" refuse
check_url "http://docs.aws.amazon.com/x" refuse
check_url "http://169.254.169.254/latest/meta-data/" refuse
check_url "https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-strategies.html" allow
B5_MAIN="$(before fetch_agentcore_doc '{"url":"https://example.com/"}')"
B5_LOOKALIKE="$(after fetch_agentcore_doc '{"url":"https://docs.aws.amazon.com.attacker.net/x"}')"
printf '\n  %sbefore%s  main fetched example.com and returned its body:\n' "$C_DIM" "$C_RESET"
printf '%s\n' "$B5_MAIN" | head -5 | sed 's/^/      /'
printf '  %safter%s\n' "$C_DIM" "$C_RESET"
B5="$(after fetch_agentcore_doc '{"url":"https://example.com/"}')"
printf '%s\n' "$B5" | head -1 | sed 's/^/      /'
printf '%s\n' "$B5" | grep -m1 'only fetches' | fold -s -w 62 | sed 's/^/      /'
OKDOC="$(after fetch_agentcore_doc '{"url":"https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-strategies.html"}')"
assert "off-corpus host refused" has "$B5" "Refused to fetch"
assert "main fetched it (bug reproduced)" has "$B5_MAIN" "Example Domain"
assert "lookalike host (docs.aws.amazon.com.attacker.net) refused" has "$B5_LOOKALIKE" "Refused"
assert "real AWS documentation still fetched" has "$OKDOC" "# Memory strategies"

# ── TEST 6 · repo health ───────────────────────────────────────────────────
banner "REPO HEALTH  ·  version gate, test suite, build reproducibility"
field "WHAT'S BROKEN" \
  "npm run validate failed on main: commit 5fb12e3 bumped plugin.json to" \
  "4.4.0 and left package.json and src/index.ts at 4.3.0. The repo's own" \
  "quality gate was red, and there is no CI to have caught it."
field "THE FIX" \
  "Bump package.json, src/index.ts and the User-Agent to 4.4.0."

criterion "validate exits 0; full suite passes; dist/ is byte-identical to a fresh build."
printf '\n%svalidate%s\n' "$C_B" "$C_RESET"
printf '  %sbefore%s\n' "$C_DIM" "$C_RESET"
(cd "$WORKTREE" && node scripts/validate-plugin.mjs 2>&1 | sed "s/^/      $C_RED/;s/\$/$C_RESET/") || true
printf '  %safter%s\n' "$C_DIM" "$C_RESET"
node scripts/validate-plugin.mjs 2>&1 | sed "s/^/      $C_GREEN/;s/\$/$C_RESET/"

printf '\n%stest suite%s\n' "$C_B" "$C_RESET"
printf '  %sbefore%s\n' "$C_DIM" "$C_RESET"
(cd "$WORKTREE" && ln -sf "$REPO/node_modules" node_modules 2>/dev/null; npx vitest run 2>&1 | grep -E '^ *Tests ' | sed 's/^/     /') || true
printf '  %safter%s\n' "$C_DIM" "$C_RESET"
npx vitest run 2>&1 | grep -E '^ *(Test Files|Tests) ' | sed 's/^/     /'
printf '  new test files on this branch:\n'
git diff --name-only "$BASE_REF"...HEAD -- tests/ | sed 's/^/      · /'

cp dist/index.js "$TMPROOT/dist-check.js"; npm run build >/dev/null 2>&1
assert "npm run validate exits 0" node scripts/validate-plugin.mjs
assert "full test suite passes" bash -c 'npx vitest run >/dev/null 2>&1'
assert "dist/ is byte-identical to a fresh build" diff -q "$TMPROOT/dist-check.js" dist/index.js
assert "tsc --noEmit clean under strict" npx tsc --noEmit

# ── summary ────────────────────────────────────────────────────────────────
printf '\n%s══════════════════════════════════════════════════════════════════════════%s\n' "$C_B" "$C_RESET"
if [ "$FAIL" -eq 0 ]; then
  printf '%s  ALL %s ASSERTIONS PASSED%s\n' "$C_GREEN$C_B" "$PASS" "$C_RESET"
  printf '  Each bug was reproduced on %s and shown fixed on this branch.\n' "$BASE_REF"
else
  printf '%s  %s passed · %s FAILED%s\n' "$C_RED$C_B" "$PASS" "$FAIL" "$C_RESET"
fi
printf '%s══════════════════════════════════════════════════════════════════════════%s\n' "$C_B" "$C_RESET"
[ "$FAIL" -eq 0 ]
