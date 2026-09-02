#!/usr/bin/env bash
#
# The audit's HTTP ladder: curl -> wget -> an honest failure.
#
# WHY THIS EXISTS
# online() was hardened to work without curl after Ubuntu's live image (which
# ships none) made every run report "server unreachable" on a machine whose
# network was fine. But the five calls that actually sign in and file the audit
# still used bare curl, so the same missing binary produced "Sign-in failed -
# check audit.conf (email/password/URL)" and sent the operator to re-check a
# password that was never wrong.
#
# These helpers live inside hardware-audit.sh, which is a top-to-bottom script
# that would run a whole audit if sourced, so the functions are extracted and
# exercised on their own against fake clients that record their argv.
#
# Note on PATH: detection only uses `command -v`, a builtin, so it can be tested
# under a stripped PATH. The REQUEST paths need mktemp/chmod/rm, so those run
# with a normal PATH and force the client through HTTP_CLIENT instead - you
# cannot hide the real curl by manipulating PATH anyway.

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
SRC="$DIR/hardware-audit.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  ok    $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; echo "     expected: $2"; echo "     actual:   $3"; }
check() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
argv() { tr '\n' ' ' < "$ARGV_OUT"; }

# --- extract just the HTTP helpers -----------------------------------------
# Four functions, so stop at the fourth closing brace - five swept up
# connect_wifi as well.
awk '/^HTTP_CLIENT=""/{p=1} p{print} p&&/^}/{n++} n==4{exit}' "$SRC" > "$WORK/http.sh"
grep -q '^http_post()' "$WORK/http.sh" || { echo "could not extract helpers"; exit 1; }
# shellcheck disable=SC1090
. "$WORK/http.sh"

# --- fake clients that record how they were called --------------------------
BOTH="$WORK/both"; ONLYWGET="$WORK/onlywget"; EMPTY="$WORK/empty"
mkdir -p "$BOTH" "$ONLYWGET" "$EMPTY"
export ARGV_OUT="$WORK/argv" BODY_OUT="$WORK/body"

mkfake() {  # mkfake <dir> <name>
  cat > "$1/$2" <<'FAKEEOF'
#!/usr/bin/env bash
: > "$ARGV_OUT"; : > "$BODY_OUT"
for a in "$@"; do printf '%s\n' "$a" >> "$ARGV_OUT"; done
# Echo back any body file we were handed, so the test can prove what was sent.
for a in "$@"; do
  case "$a" in
    --post-file=*) cat "${a#--post-file=}" > "$BODY_OUT" ;;
    @*)            [ -f "${a#@}" ] && cat "${a#@}" > "$BODY_OUT" ;;
  esac
done
echo '{"accessToken":"tok"}'
FAKEEOF
  chmod +x "$1/$2"
}
mkfake "$BOTH" curl; mkfake "$BOTH" wget; mkfake "$ONLYWGET" wget

OLDPATH="$PATH"
detect() { PATH="$1"; HTTP_CLIENT=""; http_client; PATH="$OLDPATH"; }

echo
echo "== which client gets picked =="
check "curl wins when both exist"   "curl" "$(detect "$BOTH")"
check "wget when curl is absent"    "wget" "$(detect "$ONLYWGET")"
check "none when neither exists"    "none" "$(detect "$EMPTY")"

echo
echo "== neither installed: fail honestly, never silently =="
PATH="$EMPTY"; HTTP_CLIENT=""
http_get "https://x/y" >/dev/null 2>&1
check "http_get returns 127"  "127" "$?"
http_post "https://x/y" '{}' >/dev/null 2>&1
check "http_post returns 127" "127" "$?"
PATH="$OLDPATH"
case "$(http_missing)" in
  *"NOT a credentials or network problem"*) ok "says it is not a credentials fault" ;;
  *) bad "says it is not a credentials fault" "the disclaimer" "$(http_missing)" ;;
esac

# The five real call sites hand headers in as trailing arguments; both clients
# must carry them, and neither may ever see the request body as an argument.
for client in wget curl; do
  echo
  echo "== $client can sign in and upload =="
  PATH="$BOTH:$OLDPATH"; HTTP_CLIENT="$client"

  out=$(http_get "https://api/x" "Authorization: Bearer T")
  check "$client: returns the response body" '{"accessToken":"tok"}' "$out"
  if [ "$client" = wget ]; then want='--header=Authorization: Bearer T'; else want='Authorization: Bearer T'; fi
  grep -qxF -- "$want" "$ARGV_OUT" && ok "$client: carries the auth header" \
    || bad "$client: carries the auth header" "$want" "$(argv)"

  http_post "https://api/auth/login" '{"password":"hunter2"}' 'Content-Type: application/json' >/dev/null
  check "$client: the body arrives intact" '{"password":"hunter2"}' "$(cat "$BODY_OUT")"
  grep -qF -- 'Content-Type: application/json' "$ARGV_OUT" && ok "$client: carries the content type" \
    || bad "$client: carries the content type" "Content-Type: application/json" "$(argv)"

  # The whole reason the body goes through a 0600 temp file: /proc/<pid>/cmdline
  # is world-readable, and this body is the account password.
  if grep -q 'hunter2' "$ARGV_OUT"; then
    bad "$client: password never reaches the command line" "no hunter2 in argv" "$(argv)"
  else
    ok "$client: password never reaches the command line"
  fi
  PATH="$OLDPATH"
done

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
