#!/usr/bin/env bash
# Builds and deploys one branded front-end.
#
#   ./deploy.sh outbid      -> Outbid   on outbidloll.web.app
#   ./deploy.sh dethrone    -> Dethrone on dethronelol.web.app
#
# Both are the same codebase against the same API; only the name differs.
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-outbid}"
API_BASE="${API_BASE:-https://outbit.onrender.com}"

case "$TARGET" in
  outbid)
    BRAND_NAME=Outbid
    PROJECT=outbidloll
    DATAFAST_WEBSITE_ID="${DATAFAST_WEBSITE_ID:-dfid_DYLUbA2vzYUGy9aQWxD0U}"
    DATAFAST_DOMAIN=outbidloll.web.app
    DATAFAST_SHARE_URL="${DATAFAST_SHARE_URL:-https://datafa.st/share/6a89ea11f5c2e520d15bace9}"
    ;;
  dethrone)
    BRAND_NAME=Dethrone
    PROJECT=dethronelol
    # Its own DataFast property; unset means analytics is simply off there.
    DATAFAST_WEBSITE_ID="${DETHRONE_DATAFAST_WEBSITE_ID:-}"
    DATAFAST_DOMAIN=dethronelol.web.app
    DATAFAST_SHARE_URL="${DETHRONE_DATAFAST_SHARE_URL:-}"
    ;;
  *)
    echo "Unknown target '$TARGET'. Use: outbid | dethrone" >&2
    exit 1
    ;;
esac

echo "Building $BRAND_NAME -> $PROJECT (API $API_BASE)"
API_BASE="$API_BASE" BRAND_NAME="$BRAND_NAME" \
DATAFAST_WEBSITE_ID="$DATAFAST_WEBSITE_ID" \
DATAFAST_DOMAIN="$DATAFAST_DOMAIN" \
DATAFAST_SHARE_URL="$DATAFAST_SHARE_URL" \
  node build.js

firebase deploy --only hosting --project "$PROJECT"
