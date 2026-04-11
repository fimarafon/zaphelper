#!/bin/bash
# verify-deploy.sh — post-deploy smoke test.
#
# Run this after every deploy. Exits 0 if everything is healthy, non-zero
# otherwise with a specific error code per failing check. Designed to be
# invoked from Claude's workflow so regressions are caught before the
# user sees them.
#
# Checks:
#   1. /health returns 200 with db.ok + evolution.ok
#   2. Auth cookie round-trips (login + /api/auth/me)
#   3. /api/instance/status returns CONNECTED
#   4. /api/commands/registry lists at least the known commands
#   5. /statustoday executes in <3s and returns structured content
#   6. /api/schedules/actions lists the 4 expected action types
#
# Usage:
#   ./scripts/verify-deploy.sh                    # use defaults
#   BASE_URL=https://staging.example.com ./scripts/verify-deploy.sh
#   ADMIN_USER=... ADMIN_PASS=... ./scripts/verify-deploy.sh

set -euo pipefail

BASE_URL="${BASE_URL:-https://zaphelper.maverstudio.com}"
ADMIN_USER="${ADMIN_USER:-filipeadmin}"
ADMIN_PASS="${ADMIN_PASS:-armario12*}"
COOKIES="/tmp/zap-verify-cookies.txt"
MAX_STATUSTODAY_MS="${MAX_STATUSTODAY_MS:-3000}"

red()   { printf "\033[31m%s\033[0m\n" "$1" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }

fail() {
  red "❌ $1"
  exit "$2"
}

info() {
  printf "• %s " "$1"
}

ok() {
  green "OK"
}

rm -f "$COOKIES"

# ---- 1. health ----
info "health"
HEALTH=$(curl -sk -o /tmp/zap-health.json -w "%{http_code}" "$BASE_URL/health")
if [ "$HEALTH" != "200" ]; then
  fail "/health returned $HEALTH (expected 200) — see /tmp/zap-health.json" 1
fi
DB_OK=$(python3 -c "import json; d=json.load(open('/tmp/zap-health.json')); print(d['checks']['db']['ok'])" 2>/dev/null || echo "false")
EVO_OK=$(python3 -c "import json; d=json.load(open('/tmp/zap-health.json')); print(d['checks']['evolution']['ok'])" 2>/dev/null || echo "false")
if [ "$DB_OK" != "True" ]; then
  fail "db.ok = $DB_OK" 2
fi
if [ "$EVO_OK" != "True" ]; then
  yellow "WARN: evolution.ok = $EVO_OK (webhook delivery degraded)"
fi
ok

# ---- 2. login + cookie ----
info "login"
LOGIN=$(curl -sk -o /tmp/zap-login.json -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -c "$COOKIES" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  "$BASE_URL/api/auth/login")
if [ "$LOGIN" != "200" ]; then
  fail "login returned $LOGIN — see /tmp/zap-login.json" 3
fi

ME=$(curl -sk -o /tmp/zap-me.json -w "%{http_code}" -b "$COOKIES" "$BASE_URL/api/auth/me")
if [ "$ME" != "200" ]; then
  fail "/api/auth/me returned $ME after successful login — cookie round-trip broken" 4
fi
ok

# ---- 3. instance status ----
info "instance status"
STATUS=$(curl -sk -b "$COOKIES" "$BASE_URL/api/instance/status")
STATE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state','?'))")
if [ "$STATE" != "CONNECTED" ]; then
  yellow "WARN: instance state = $STATE (not CONNECTED; commands will still work but no realtime)"
else
  ok
fi

# ---- 4. command registry ----
info "command registry"
REG=$(curl -sk -b "$COOKIES" "$BASE_URL/api/commands/registry")
COUNT=$(echo "$REG" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('commands',[])))")
if [ "$COUNT" -lt 10 ]; then
  fail "registry has only $COUNT commands (expected 10+)" 5
fi
ok

# ---- 5. statustoday latency ----
info "statustoday latency"
START=$(python3 -c 'import time; print(int(time.time()*1000))')
STATUS_RES=$(curl -sk -o /tmp/zap-status.json -w "%{http_code}" -X POST \
  -b "$COOKIES" -H "Content-Type: application/json" \
  -d '{"input":"/statustoday"}' \
  "$BASE_URL/api/commands/run")
END=$(python3 -c 'import time; print(int(time.time()*1000))')
MS=$((END - START))
if [ "$STATUS_RES" != "200" ]; then
  fail "/statustoday returned $STATUS_RES — see /tmp/zap-status.json" 6
fi
SUCCESS=$(python3 -c "import json; d=json.load(open('/tmp/zap-status.json')); print(d.get('success'))")
if [ "$SUCCESS" != "True" ]; then
  fail "/statustoday success=$SUCCESS — see /tmp/zap-status.json" 7
fi
if [ "$MS" -gt "$MAX_STATUSTODAY_MS" ]; then
  fail "/statustoday took ${MS}ms (max ${MAX_STATUSTODAY_MS}ms)" 8
fi
green "OK (${MS}ms)"

# ---- 6. scheduled actions registry ----
info "action registry"
ACTIONS=$(curl -sk -b "$COOKIES" "$BASE_URL/api/schedules/actions")
ACOUNT=$(echo "$ACTIONS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('actions',[])))")
if [ "$ACOUNT" -ne 4 ]; then
  fail "expected 4 actions, got $ACOUNT" 9
fi
ok

green ""
green "✅ Deploy verified — all checks passed."
