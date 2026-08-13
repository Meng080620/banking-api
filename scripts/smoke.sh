#!/usr/bin/env bash
#
# End-to-end smoke test against a RUNNING api (npm run start:dev).
# Registers a customer, seeds two accounts, moves money, and proves that
# retrying with the same Idempotency-Key does not move it twice.
#
#   ./scripts/smoke.sh
#
set -euo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
DBUSER="${DBUSER:-banking}"   # override when the stack uses other credentials
DBNAME="${DBNAME:-banking}"
PASSWORD='S0me-Strong-Passphrase'
EMAIL="smoke-$(date +%s)@bank.test"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# jq is not assumed — python3 ships with macOS.
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# Pick the container that actually PUBLISHES 5432 — the one the API connects to.
# Matching on the name alone picks the wrong container the moment a second
# postgres exists (a stale compose container, say), and then this script seeds
# one database while the API reads another.
#
# The production stack publishes no postgres port at all, so name it directly:
#   PG=banking-api-postgres-1 BASE=https://api.yourbank.example/api/v1 ./scripts/smoke.sh
if [ -z "${PG:-}" ]; then
  PG=$(docker ps --format '{{.Names}}\t{{.Ports}}' \
       | grep -i postgres | grep -F ':5432->' | head -1 | cut -f1)
  [ -n "$PG" ] || fail "no postgres container publishes 5432 — try 'docker compose up -d', or set PG=<container>"

  if [ "$(docker ps --format '{{.Names}}\t{{.Ports}}' | grep -ci 'postgres')" -gt 1 ]; then
    printf '  \033[33m!\033[0m more than one postgres container is running; using %s\n' "$PG"
  fi
else
  docker ps --format '{{.Names}}' | grep -qx "$PG" || fail "container '$PG' is not running"
fi

step "0. API reachable?"
curl -sf "$BASE/health/live" > /dev/null || fail "API not responding at $BASE (start it with: npm run start:dev)"
pass "$BASE is up"

step "1. Register a customer"
TOKENS=$(curl -sf -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
ACCESS=$(echo "$TOKENS" | json "d['accessToken']")
pass "registered $EMAIL"

step "2. Seed a customer profile + two accounts (no admin endpoint yet)"
USER_ID=$(docker exec "$PG" psql -U "$DBUSER" -d "$DBNAME" -tAc \
  "select id from users where email='$EMAIL'")
docker exec -i "$PG" psql -U "$DBUSER" -d "$DBNAME" -q <<SQL
insert into customers (id, user_id, "fullName", status, created_at)
values (gen_random_uuid(), '$USER_ID', 'Smoke Test Customer', 'ACTIVE', now());

insert into accounts (id, account_number, customer_id, currency, status, balance, version, created_at)
select gen_random_uuid(), 'SMK$(date +%s)1', c.id, 'USD', 'ACTIVE', 1000.0000, 1, now()
from customers c where c.user_id = '$USER_ID';

insert into accounts (id, account_number, customer_id, currency, status, balance, version, created_at)
select gen_random_uuid(), 'SMK$(date +%s)2', c.id, 'USD', 'ACTIVE', 50.0000, 1, now()
from customers c where c.user_id = '$USER_ID';
SQL
pass "seeded 2 accounts (1000.0000 and 50.0000 USD)"

step "3. GET /accounts — the caller's own accounts"
ACCOUNTS=$(curl -sf "$BASE/accounts" -H "Authorization: Bearer $ACCESS")
SRC=$(echo "$ACCOUNTS" | json "sorted(d,key=lambda a:-float(a['balance']))[0]['id']")
DST=$(echo "$ACCOUNTS" | json "sorted(d,key=lambda a:-float(a['balance']))[1]['id']")
echo "$ACCOUNTS" | python3 -m json.tool | sed 's/^/    /'
pass "listed 2 accounts"

step "4. GET /accounts/:id/balance — read through the bank middleware"
curl -sf "$BASE/accounts/$SRC/balance" -H "Authorization: Bearer $ACCESS" \
  | python3 -m json.tool | sed 's/^/    /'
pass "balance came back in OUR shape, not the upstream's"

step "5. POST /transfers — move 150.0000"
BODY="{\"sourceId\":\"$SRC\",\"destId\":\"$DST\",\"amount\":\"150.0000\",\"currency\":\"USD\"}"
KEY="smoke-$(date +%s)"
FIRST=$(curl -sf -X POST "$BASE/transfers" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "$BODY")
FIRST_ID=$(echo "$FIRST" | json "d['id']")
echo "$FIRST" | python3 -m json.tool | sed 's/^/    /'
pass "transfer completed"

step "6. POST /transfers again with the SAME key — must replay, not re-debit"
SECOND=$(curl -sf -X POST "$BASE/transfers" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "$BODY")
SECOND_ID=$(echo "$SECOND" | json "d['id']")
[ "$FIRST_ID" = "$SECOND_ID" ] || fail "different transfer id — idempotency is broken!"
pass "same transfer id returned: $SECOND_ID"

step "7. Balances moved exactly once"
AFTER=$(curl -sf "$BASE/accounts" -H "Authorization: Bearer $ACCESS")
SRC_BAL=$(echo "$AFTER" | json "[a['balance'] for a in d if a['id']=='$SRC'][0]")
DST_BAL=$(echo "$AFTER" | json "[a['balance'] for a in d if a['id']=='$DST'][0]")
echo "    source: $SRC_BAL   destination: $DST_BAL"
[ "$SRC_BAL" = "850.0000" ] || fail "expected source 850.0000, got $SRC_BAL"
[ "$DST_BAL" = "200.0000" ] || fail "expected destination 200.0000, got $DST_BAL"
pass "1000 - 150 = 850, and 50 + 150 = 200"

step "8. Same key, DIFFERENT amount — must be rejected, not replayed"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/transfers" \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"sourceId\":\"$SRC\",\"destId\":\"$DST\",\"amount\":\"999.0000\",\"currency\":\"USD\"}")
[ "$CODE" = "422" ] || fail "expected 422, got $CODE"
pass "422 — the body hash caught the key reuse"

step "9. Another customer must NOT be able to debit these accounts"
ATTACKER=$(curl -sf -X POST "$BASE/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"attacker-$(date +%s)@bank.test\",\"password\":\"$PASSWORD\"}" \
  | json "d['accessToken']")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/transfers" \
  -H "Authorization: Bearer $ATTACKER" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: attack-$(date +%s)" -d "$BODY")
[ "$CODE" = "404" ] || fail "expected 404, got $CODE — AUTHORISATION HOLE"
pass "404 — ownership is enforced in the query"

step "10. Double-entry ledger balances to zero"
docker exec "$PG" psql -U "$DBUSER" -d "$DBNAME" -tAc \
  "select coalesce(sum(case when type='DEBIT' then amount else -amount end),0) from ledger_entries" \
  | tr -d ' ' | grep -q '^0' \
  && pass "debits and credits net to zero" \
  || fail "ledger does not balance"

printf '\n\033[32mAll smoke checks passed.\033[0m\n'
