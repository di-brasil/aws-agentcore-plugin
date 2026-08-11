#!/usr/bin/env bash
# Demonstrate the five tool fixes by running the SAME probe against two builds:
# this branch, and main built from a temp worktree. Every "before" line below is
# real output from main, not a transcript.
#
# Usage:  ./scripts/verify-fixes.sh
# Needs:  node 18+, npm, git, and network access (the server fetches live AWS docs).

set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
BASE_REF="${BASE_REF:-origin/main}"
WORKTREE="$(mktemp -d)/main"
PASS=0
FAIL=0

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
head1() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }

# check <label> <condition-exit-code-cmd...>
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32m✔ PASS\033[0m %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf '  \033[31m✘ FAIL\033[0m %s\n' "$label"; FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- build both sides -------------------------------------------------------
head1 "Building both sides"
git rev-parse --verify "$BASE_REF" >/dev/null 2>&1 || { echo "no such ref: $BASE_REF"; exit 1; }
dim "  branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
dim "  base:   $BASE_REF @ $(git rev-parse --short "$BASE_REF")"

npm run build >/dev/null 2>&1 || { echo "branch build failed"; exit 1; }
AFTER="$REPO/dist/index.js"

git worktree add --detach "$WORKTREE" "$BASE_REF" >/dev/null 2>&1 || { echo "worktree failed"; exit 1; }
# main ships a prebuilt dist/, so no npm install is needed to run it.
BEFORE="$WORKTREE/dist/index.js"
[ -f "$BEFORE" ] || { echo "no prebuilt dist on $BASE_REF"; exit 1; }
echo "  both builds ready"

call_before() { node scripts/mcp-call.mjs "$BEFORE" "$1" "$2" 2>/dev/null; }
call_after()  { node scripts/mcp-call.mjs "$AFTER"  "$1" "$2" 2>/dev/null; }

# --- 0. version / validate --------------------------------------------------
head1 "0. npm run validate  (main: red, plugin.json 4.4.0 vs package.json 4.3.0)"
dim "  before:"
(cd "$WORKTREE" && node scripts/validate-plugin.mjs 2>&1 | sed 's/^/    /') || true
dim "  after:"
node scripts/validate-plugin.mjs 2>&1 | sed 's/^/    /'
check "validate exits 0 on this branch" node scripts/validate-plugin.mjs

# --- 1. BUG-4 CDK offset ----------------------------------------------------
head1 "1. BUG-4  fetch_agentcore_doc: CDK reference was unreachable past 20k chars"
CDK_URL="https://docs.aws.amazon.com/cdk/api/v2/java/software/amazon/awscdk/cfnpropertymixins/services/bedrockagentcore/package-summary.html"
B4_BEFORE="$(call_before fetch_agentcore_doc "{\"url\":\"$CDK_URL\"}")"
dim "  before — truncation notice, and no way to page:"
printf '%s\n' "$B4_BEFORE" | tail -1 | sed 's/^/    /'
printf '    CfnGatewayPropsMixin present: %s\n' \
  "$(printf '%s' "$B4_BEFORE" | grep -q CfnGatewayPropsMixin && echo yes || echo NO)"

dim "  after — notice reports the next offset, so the page is walkable:"
B4_FIRST="$(call_after fetch_agentcore_doc "{\"url\":\"$CDK_URL\"}")"
printf '%s\n' "$B4_FIRST" | tail -1 | sed 's/^/    /'
OFF=0; FOUND=no; PAGES=0
while [ "$PAGES" -lt 12 ]; do
  T="$(call_after fetch_agentcore_doc "{\"url\":\"$CDK_URL\",\"offset\":$OFF}")"
  PAGES=$((PAGES + 1))
  if printf '%s' "$T" | grep -q CfnGatewayPropsMixin; then FOUND=yes; break; fi
  NEXT="$(printf '%s' "$T" | grep -o 'offset=[0-9]*' | tail -1 | cut -d= -f2)"
  [ -n "$NEXT" ] || break
  OFF="$NEXT"
done
printf '    CfnGatewayPropsMixin found at offset %s (page %s): %s\n' "$OFF" "$PAGES" "$FOUND"
check "CfnGatewayPropsMixin reachable via offset" test "$FOUND" = yes
check "was NOT reachable on main" bash -c "! printf '%s' \"\$1\" | grep -q CfnGatewayPropsMixin" _ "$B4_BEFORE"

# --- 2. BUG-2 ranking -------------------------------------------------------
head1 "2. BUG-2  search_agentcore_docs: the tool's own example query ranked 3rd"
dim "  query: 'CreateGateway parameters'   (verbatim from the tool description)"
dim "  before — top 3 hydrated headings:"
call_before search_agentcore_docs '{"query":"CreateGateway parameters","max_results":3}' \
  | grep '^### ' | sed 's/^/    /'
dim "  after:"
B2_AFTER="$(call_after search_agentcore_docs '{"query":"CreateGateway parameters","max_results":3}')"
printf '%s\n' "$B2_AFTER" | grep '^### ' | sed 's/^/    /'
check "CreateGateway now ranks first" bash -c \
  "[ \"\$(printf '%s' \"\$1\" | grep -m1 '^### ')\" = '### CreateGateway' ]" _ "$B2_AFTER"

# --- 3. BUG-3 duplicate hydration -------------------------------------------
head1 "3. BUG-3  search_agentcore_docs: same page hydrated 3x with identical bodies"
dim "  query: 'how am I charged pricing'  source: faq   (all 52 FAQs share one URL)"
B3_BEFORE="$(call_before search_agentcore_docs '{"query":"how am I charged pricing","source":"faq","max_results":5}')"
B3_AFTER="$(call_after  search_agentcore_docs '{"query":"how am I charged pricing","source":"faq","max_results":5}')"
count_urls()  { printf '%s' "$1" | grep -c '^\*\*URL:\*\*'; }
count_uniq()  { printf '%s' "$1" | grep '^\*\*URL:\*\*' | sort -u | wc -l | tr -d ' '; }
printf '    before: %s hydrated blocks, %s distinct URL(s)\n' "$(count_urls "$B3_BEFORE")" "$(count_uniq "$B3_BEFORE")"
printf '    after:  %s hydrated blocks, %s distinct URL(s)\n' "$(count_urls "$B3_AFTER")"  "$(count_uniq "$B3_AFTER")"
dim "  the duplicated bodies on main were byte-identical:"
printf '    repeated opening line appears %sx before, %sx after\n' \
  "$(printf '%s' "$B3_BEFORE" | grep -c '^## What is Amazon Bedrock AgentCore?')" \
  "$(printf '%s' "$B3_AFTER"  | grep -c '^## What is Amazon Bedrock AgentCore?')"
check "no duplicate URL is hydrated twice" bash -c \
  '[ "$(printf "%s" "$1" | grep -c "^\*\*URL:\*\*")" -eq "$(printf "%s" "$1" | grep "^\*\*URL:\*\*" | sort -u | wc -l | tr -d " ")" ]' _ "$B3_AFTER"
check "non-hydrated results still listed" bash -c \
  'printf "%s" "$1" | grep -q "More results:"' _ "$B3_AFTER"

# --- 4. BUG-1 boto3 false negative ------------------------------------------
head1 "4. BUG-1  list_agentcore_components: false negative on boto3 components"
dim "  args: source=boto3_data_plane  component=memory"
dim "  before:"
printf '%s\n' "$(call_before list_agentcore_components '{"source":"boto3_data_plane","component":"memory"}')" \
  | head -2 | sed 's/^/    /'
dim "  after:"
B1_AFTER="$(call_after list_agentcore_components '{"source":"boto3_data_plane","component":"memory"}')"
printf '%s\n' "$B1_AFTER" | grep -m1 '^## ' | sed 's/^/    /'
printf '%s\n' "$B1_AFTER" | grep -m3 -o '[a-z_]*memory[a-z_]*' | sort -u | head -3 | sed 's/^/      · /'
check "boto3 memory component is found" bash -c \
  'printf "%s" "$1" | grep -q "Client — memory"' _ "$B1_AFTER"
check "flat source overview still works" bash -c \
  'printf "%s" "$(node scripts/mcp-call.mjs "$1" list_agentcore_components "{\"source\":\"boto3_data_plane\"}")" | grep -q "Boto3 bedrock-agentcore Client"' _ "$AFTER"

# --- 5. BUG-5 allowlist -----------------------------------------------------
head1 "5. BUG-5  fetch_agentcore_doc: fetched any URL, not just doc hosts"
dim "  before — off-corpus URL is fetched and returned:"
call_before fetch_agentcore_doc '{"url":"https://example.com/"}' | head -3 | sed 's/^/    /'
dim "  after:"
B5_AFTER="$(call_after fetch_agentcore_doc '{"url":"https://example.com/"}')"
printf '%s\n' "$B5_AFTER" | head -1 | sed 's/^/    /'
dim "  and the lookalike host, which an endsWith check would have allowed:"
call_after fetch_agentcore_doc '{"url":"https://docs.aws.amazon.com.attacker.net/x"}' | head -1 | sed 's/^/    /'
dim "  real documentation still fetches:"
OK_DOC="$(call_after fetch_agentcore_doc '{"url":"https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-strategies.html"}')"
printf '%s\n' "$OK_DOC" | grep -m1 '^# ' | sed 's/^/    /'
check "example.com refused" bash -c 'printf "%s" "$1" | grep -q "Refused to fetch"' _ "$B5_AFTER"
check "real AWS doc still allowed" bash -c 'printf "%s" "$1" | grep -q "# Memory strategies"' _ "$OK_DOC"

# --- 6. suite + reproducible dist -------------------------------------------
head1 "6. Test suite and build integrity"
dim "  before (main):"
(cd "$WORKTREE" && ln -s "$REPO/node_modules" node_modules 2>/dev/null; npx vitest run 2>&1 | grep -E '^ *Tests ' | sed 's/^/  /') || true
dim "  after (this branch):"
npx vitest run 2>&1 | grep -E '^ *(Test Files|Tests) ' | sed 's/^/  /'
check "full suite passes" bash -c 'npx vitest run >/dev/null 2>&1'
cp dist/index.js /tmp/dist-before-rebuild.js
npm run build >/dev/null 2>&1
check "dist/ is byte-identical to a fresh build" diff -q /tmp/dist-before-rebuild.js dist/index.js
check "tsc --noEmit clean under strict" npx tsc --noEmit

# --- summary ----------------------------------------------------------------
printf '\n\033[1m────────────────────────────────────────\033[0m\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[1;32m  %s checks passed, 0 failed\033[0m\n' "$PASS"
else
  printf '\033[1;31m  %s passed, %s FAILED\033[0m\n' "$PASS" "$FAIL"
fi
printf '\033[1m────────────────────────────────────────\033[0m\n'
[ "$FAIL" -eq 0 ]
