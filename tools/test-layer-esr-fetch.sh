#!/usr/bin/env bash
# Tests for how make-als-layer.sh fetches Firefox ESR from Mozilla's APT repo.
#
# What must hold:
#   - the signing key is checked against Mozilla's published fingerprint, and
#     a mismatch STOPS the build (a wrong key means apt would trust whatever
#     it signs);
#   - a key file with the right key PLUS another one is refused too, because
#     signed-by= trusts every key in the file;
#   - the apt source and the key live only in a private work directory: the
#     build host's /etc/apt is never named, and nothing but the .deb lands in
#     the stage (so no key or source can be packed into the layer);
#   - no network is a benign skip (build continues, snapd left alone), not a
#     failure.
#
#   bash tools/test-layer-esr-fetch.sh
#
# Real gpg (throwaway GNUPGHOME, generated test keys); apt-get and wget are
# stubs that only log. Nothing is downloaded, nothing outside a temp dir is
# written.

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s   (%s)\n' "$1" "$2"; }

command -v gpg >/dev/null 2>&1 || { echo "gpg is required for this test (apt-get install gnupg)"; exit 1; }

T=$(mktemp -d)
trap 'gpgconf --kill all >/dev/null 2>&1; rm -rf "$T"' EXIT
export GNUPGHOME="$T/gnupg"; mkdir -p "$GNUPGHOME"; chmod 0700 "$GNUPGHOME"

# shellcheck disable=SC1091
ALS_LAYER_LIB=1 . "$HERE/make-als-layer.sh" || { echo "could not source make-als-layer.sh"; exit 1; }

[ "$MOZ_FPR" = "35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3" ] \
  && ok "pinned fingerprint is Mozilla's published one" || bad "pinned fingerprint" "$MOZ_FPR"
case "$MOZ_KEY_URL" in https://packages.mozilla.org/*) ok "key comes from packages.mozilla.org over https" ;;
  *) bad "key URL" "$MOZ_KEY_URL" ;; esac

# Two throwaway keys.
genkey() {
  gpg --batch --quiet --passphrase '' --quick-gen-key "$1" ed25519 sign never >/dev/null 2>&1
  gpg --batch --with-colons --list-keys "$1" 2>/dev/null | awk -F: '$1=="fpr"{print $10; exit}'
}
FPR_A=$(genkey "ALS Test A <a@test.invalid>")
FPR_B=$(genkey "ALS Test B <b@test.invalid>")
[ -n "$FPR_A" ] && [ -n "$FPR_B" ] || { echo "could not generate test keys"; exit 1; }
gpg --batch --armor --export "$FPR_A" > "$T/a.asc"
gpg --batch --armor --export "$FPR_B" > "$T/b.asc"
cat "$T/a.asc" "$T/b.asc" > "$T/ab.asc"
printf '<html>captive portal</html>\n' > "$T/html.asc"

echo "als_key_ok"
als_key_ok "$T/a.asc" "$FPR_A" >/dev/null && ok "the right single key is accepted" || bad "right key" "refused"
als_key_ok "$T/b.asc" "$FPR_A" >/dev/null && bad "wrong key refused" "accepted" || ok "a different key is refused"
als_key_ok "$T/ab.asc" "$FPR_A" >/dev/null && bad "extra key refused" "accepted" || ok "right key + an extra key is refused"
als_key_ok "$T/html.asc" "$FPR_A" >/dev/null && bad "html refused" "accepted" || ok "a non-key (captive portal page) is refused"
als_key_ok "$T/a.asc" "$(echo "$FPR_A" | tr 'A-F' 'a-f')" >/dev/null && bad "case" "lower-case expected matched" \
  || ok "comparison is exact (upper-case, as gpg prints)"
als_key_ok "$T/a.asc" >/dev/null && bad "default expected" "a test key matched Mozilla's fingerprint" \
  || ok "a test key never matches the pinned Mozilla fingerprint"

# --- stubs for the fetch ------------------------------------------------------
STUB="$T/stub"; mkdir -p "$STUB"
LOG="$T/apt.log"
cat > "$STUB/apt-get" <<EOF
#!/bin/sh
echo "apt-get \$*" >> "$LOG"
for a in "\$@"; do
  case "\$a" in download) printf 'deb' > "firefox-esr_153.3.0esr~build1_amd64.deb" ;; esac
done
exit \${STUB_APT_RC:-0}
EOF
cat > "$STUB/wget" <<EOF
#!/bin/sh
# wget -q -T 30 -O <out> <url>
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-O" ] && out="\$a"; prev="\$a"; done
[ -n "\${STUB_KEY:-}" ] || exit 4
cp "\$STUB_KEY" "\$out"
EOF
# python3 is als_fetch's fallback when there is no wget. It must never reach
# the network from a test either.
printf '#!/bin/sh\necho "python3 $*" >> "%s"\nexit 1\n' "$T/python3.log" > "$STUB/python3"
chmod +x "$STUB/apt-get" "$STUB/wget" "$STUB/python3"
PATH="$STUB:$PATH"; export PATH

fresh() { rm -rf "$T/work" "$T/stage" "$LOG"; mkdir -p "$T/work" "$T/stage/.debs"; }
stage_extra() { find "$T/stage" -mindepth 1 ! -path "$T/stage/.debs" ! -name 'firefox-esr_*.deb' | head -5; }

echo "fetch with a key that does NOT match"
fresh
( MOZ_FPR="$FPR_A"; STUB_KEY="$T/b.asc" als_fetch_esr "$T/work" "$T/stage/.debs" ) >"$T/out" 2>&1; rc=$?
[ "$rc" != "0" ] && ok "the build stops (rc=$rc)" || bad "mismatch stops the build" "rc=0"
grep -q 'did NOT verify' "$T/out" && ok "and says why" || bad "message" "$(tail -3 "$T/out")"
[ ! -e "$LOG" ] && ok "apt-get was never run" || bad "apt-get not run" "$(cat "$LOG")"
[ -z "$(ls "$T/stage/.debs")" ] && ok "nothing downloaded" || bad "nothing downloaded" "$(ls "$T/stage/.debs")"

echo "fetch with the right key plus an extra one"
fresh
( MOZ_FPR="$FPR_A"; STUB_KEY="$T/ab.asc" als_fetch_esr "$T/work" "$T/stage/.debs" ) >"$T/out" 2>&1; rc=$?
[ "$rc" != "0" ] && [ ! -e "$LOG" ] && ok "stops before apt" || bad "extra key stops" "rc=$rc $(cat "$LOG" 2>/dev/null)"

echo "no network"
fresh
( MOZ_FPR="$FPR_A"; STUB_KEY="" als_fetch_esr "$T/work" "$T/stage/.debs" ) >"$T/out" 2>&1; rc=$?
[ "$rc" = "1" ] && ok "benign skip (rc=1), not a die" || bad "offline rc" "$rc $(tail -2 "$T/out")"
grep -q 'snapd left as it is' "$T/out" && ok "says snapd is left alone" || bad "offline message" "$(tail -2 "$T/out")"
[ ! -e "$T/python3.log" ] && ok "a failed wget is final (no second attempt by another route)" \
  || bad "no python3 fallback when wget exists" "$(cat "$T/python3.log")"

echo "repository unreachable after the key verified"
fresh
( MOZ_FPR="$FPR_A"; STUB_KEY="$T/a.asc"; STUB_APT_RC=100; export STUB_APT_RC
  als_fetch_esr "$T/work" "$T/stage/.debs" ) >"$T/out" 2>&1; rc=$?
[ "$rc" = "1" ] && ok "benign skip" || bad "apt failure rc" "$rc"
[ -z "$(ls "$T/stage/.debs")" ] && ok "nothing left in .debs" || bad "debs after failure" "$(ls "$T/stage/.debs")"

echo "fetch with the right key"
fresh
( MOZ_FPR="$FPR_A"; STUB_KEY="$T/a.asc" als_fetch_esr "$T/work" "$T/stage/.debs" ) >"$T/out" 2>&1; rc=$?
[ "$rc" = "0" ] && ok "succeeds" || bad "right key fetch" "rc=$rc $(tail -3 "$T/out")"
[ "$(ls "$T/stage/.debs")" = "firefox-esr_153.3.0esr~build1_amd64.deb" ] && ok "exactly the firefox-esr deb downloaded" \
  || bad "downloaded" "$(ls "$T/stage/.debs")"
[ -z "$(stage_extra)" ] && ok "the stage holds nothing but that .deb (no key, no source list)" || bad "stage clean" "$(stage_extra)"
grep -q "signed-by=$T/work/mozilla.asc" "$T/work/mozilla.list" && ok "source is signed-by the verified key file" \
  || bad "signed-by" "$(cat "$T/work/mozilla.list")"
grep -q 'https://packages.mozilla.org/apt mozilla main' "$T/work/mozilla.list" && ok "source is Mozilla's repo" \
  || bad "source line" "$(cat "$T/work/mozilla.list")"
n_update=$(grep -c ' update' "$LOG"); n_dl=$(grep -c ' download firefox-esr' "$LOG")
[ "$n_update" = "1" ] && [ "$n_dl" = "1" ] && ok "one apt-get update, one download of firefox-esr only" \
  || bad "apt calls" "$(cat "$LOG")"
bad_calls=$(grep -v -- "-o Dir::Etc::SourceList=$T/work/mozilla.list" "$LOG")
[ -z "$bad_calls" ] && ok "every apt call uses the private source list" || bad "private source list" "$bad_calls"
for opt in "Dir::Etc::SourceParts=$T/work/parts.d" "Dir::State::Lists=$T/work/lists" "Dir::Cache=$T/work/cache"; do
  [ "$(grep -c -- "-o $opt" "$LOG")" = "2" ] && ok "every apt call uses $opt" || bad "$opt" "$(cat "$LOG")"
done
grep -q '/etc/apt' "$LOG" && bad "host /etc/apt never named" "$(grep /etc/apt "$LOG")" || ok "host /etc/apt is never named"
[ -z "$(ls "$T/work/parts.d")" ] && ok "the private sources.list.d is empty (host sources are not mixed in)" \
  || bad "parts.d empty" "$(ls "$T/work/parts.d")"

echo "do_build wiring"
L=$HERE/make-als-layer.sh
grep -q 'MOZ_WORK=$(mktemp -d)' "$L" && ok "work dir is its own mktemp, not under the stage" || bad "work dir" "missing"
grep -q 'als_fetch_esr "$MOZ_WORK" "$DEBS"' "$L" && ok "ESR lands in the same .debs the build unpacks and deletes" || bad "fetch call" "missing"
grep -q "ALS_ESR:-1" "$L" && ok "ALS_ESR=0 opt-out exists" || bad "opt-out" "missing"
grep -q "dpkg-query -W -f='\${Status}' firefox-esr" "$L" && ok "an installed firefox-esr stops the build (no shadowing)" || bad "installed gate" "missing"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
