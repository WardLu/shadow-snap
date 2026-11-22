#!/usr/bin/env bash
# Read-only verifier for a staged deployment URL or the configured production domains.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: bash scripts/release/verify-site-content.sh URL COMMIT_SHA [public|deployment]" >&2
  exit 1
fi
BASE_URL="$1"
HEAD_SHA="$2"
ACCESS="${3:-public}"
if [ "$HEAD_SHA" != "$(git rev-parse HEAD)" ] || [ -n "$(git status --porcelain)" ]; then
  echo "❌ 只读验收要求工作区干净且 HEAD 等于目标提交。" >&2
  exit 1
fi
node --input-type=module -e '
import {readFileSync} from "node:fs";
const config=JSON.parse(readFileSync("config/release-production.json","utf8"));
const [base,access]=process.argv.slice(1); const url=new URL(base);
if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash || url.pathname!=="/") throw new Error("verify_url_invalid");
if(access==="public" ? !config.vercel.productionDomains.includes(url.hostname) : access!=="deployment" || !url.hostname.endsWith(".vercel.app")) throw new Error("verify_host_not_allowed");
' "$BASE_URL" "$ACCESS"
TEAM_ID="$(node scripts/release/release-config.mjs get vercel.teamId)"
if [ "$ACCESS" = "deployment" ]; then
  node scripts/release/vercel-project-binding.mjs
fi
VERIFY_MANIFEST="$(node scripts/seo/site-artifact-manifest.mjs)"
if [ -z "$VERIFY_MANIFEST" ]; then echo "❌ 验收清单为空。" >&2; exit 1; fi
SHADOW_CURL_BIN="$(command -v curl)"
case "$SHADOW_CURL_BIN" in /*) ;; *) exit 1 ;; esac
export SHADOW_CURL_BIN
. "$ROOT_DIR/scripts/release/site-content-functions.sh"
verify_against_commit "${BASE_URL%/}" "只读内容验收" "$ACCESS"
