#!/usr/bin/env bash
#
# Checks .env.production BEFORE a deploy, so the stack fails on your terminal
# instead of at 2am in a container restart loop.
#
#   ./scripts/preflight.sh
#
set -euo pipefail

ENV_FILE="${1:-.env.production}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
FAILED=0

[ -f "$ENV_FILE" ] || {
  printf '\033[31m%s does not exist.\033[0m  cp .env.production.example %s\n' \
    "$ENV_FILE" "$ENV_FILE"
  exit 1
}

# Read values without sourcing the file — a stray command in an env file should
# not execute just because someone ran a preflight check.
get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

printf '\n\033[1mChecking %s\033[0m\n' "$ENV_FILE"

for key in NODE_ENV DATABASE_HOST DATABASE_USER DATABASE_PASSWORD DATABASE_NAME \
           REDIS_HOST JWT_SECRET MIDDLEWARE_URL; do
  [ -n "$(get "$key")" ] && pass "$key is set" || fail "$key is empty or missing"
done

SECRET=$(get JWT_SECRET)
if [ "${#SECRET}" -lt 32 ]; then
  fail "JWT_SECRET is ${#SECRET} chars — the app will refuse to boot under 32"
else
  pass "JWT_SECRET is ${#SECRET} chars"
fi
case "$SECRET" in
  replace_with_*|change_me*) fail "JWT_SECRET is still the example value" ;;
esac

# The API connects with DATABASE_PASSWORD; the postgres image creates the role
# with POSTGRES_PASSWORD. Different values means every query fails on boot.
if [ -n "$(get POSTGRES_PASSWORD)" ]; then
  [ "$(get POSTGRES_PASSWORD)" = "$(get DATABASE_PASSWORD)" ] \
    && pass "POSTGRES_PASSWORD matches DATABASE_PASSWORD" \
    || fail "POSTGRES_PASSWORD != DATABASE_PASSWORD — the API cannot log in"
  [ "$(get POSTGRES_USER)" = "$(get DATABASE_USER)" ] \
    && pass "POSTGRES_USER matches DATABASE_USER" \
    || fail "POSTGRES_USER != DATABASE_USER"
  [ "$(get POSTGRES_DB)" = "$(get DATABASE_NAME)" ] \
    && pass "POSTGRES_DB matches DATABASE_NAME" \
    || fail "POSTGRES_DB != DATABASE_NAME"
else
  warn "no POSTGRES_* values — assuming a managed database, not the compose one"
fi

if [ "$(get NODE_ENV)" = "production" ]; then
  case "$(get MIDDLEWARE_URL)" in
    *localhost*|*127.0.0.1*)
      # The mock upstream is excluded from the app in production, so pointing
      # MIDDLEWARE_URL at ourselves means every balance read 502s.
      fail "MIDDLEWARE_URL points at localhost, but the mock does not ship in production" ;;
    https://*) pass "MIDDLEWARE_URL is a remote https endpoint" ;;
    *) warn "MIDDLEWARE_URL is not https — bank traffic should be encrypted" ;;
  esac
fi

PERMS=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")
[ "$PERMS" = "600" ] && pass "file mode is 600" \
  || warn "file mode is $PERMS — run: chmod 600 $ENV_FILE"

if [ "$FAILED" -eq 1 ]; then
  printf '\n\033[31mPreflight failed. Fix the above before deploying.\033[0m\n'
  exit 1
fi
printf '\n\033[32mPreflight passed.\033[0m\n'
