#!/usr/bin/env bash
set -uo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
unit_path="$repo_root/crates/keylab/keylab.service"
binary_path="$repo_root/target/release/keylab"
lock_path="$repo_root/Cargo.lock"
keymap_path="$repo_root/out/keymap-meta.json"
score_path="$repo_root/docs/keylab-security-score.txt"
failures=0
writer_pid=
verify_tmp=$(mktemp -d)

cleanup() {
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  rm -rf -- "$verify_tmp"
}
trap cleanup EXIT INT TERM

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

skip() {
  printf 'SKIP: %s\n' "$1"
}

finish_writer() {
  if [[ -n "$writer_pid" ]] && kill -0 "$writer_pid" 2>/dev/null; then
    kill "$writer_pid" 2>/dev/null || true
    wait "$writer_pid" 2>/dev/null || true
  fi
  writer_pid=
}

wait_for_writer() {
  local log_path=$1
  local attempt

  for ((attempt = 0; attempt < 200; attempt++)); do
    if grep -q '^SELFTEST_DB_READY ' "$log_path" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$writer_pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.05
  done
  return 1
}

printf '%s\n' 'keylab hardening verification'

if [[ -x /usr/local/bin/keylab && -f /etc/systemd/system/keylab.service ]]; then
  pass 'installed binary and system unit are present; offline checks use repository artefacts'
else
  skip 'keylab is not installed; live service start/capture checks are skipped, repository checks continue'
fi

if (cd -- "$repo_root" && cargo build --release --locked); then
  pass 'release binary builds from the locked dependency graph'
else
  fail 'release binary did not build'
fi

printf '%s\n' 'Check 1: systemd exposure score'
if ! command -v systemd-analyze >/dev/null 2>&1; then
  fail 'systemd-analyze is required for the offline unit review'
else
  security_output=$(SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat \
    systemd-analyze security --offline=true --no-pager "$unit_path" 2>&1)
  security_status=$?
  score=$(printf '%s\n' "$security_output" | sed -nE \
    's/.*Overall exposure level for .*: ([0-9]+([.][0-9]+)?).*/\1/p' | tail -n 1)
  if ((security_status != 0)) || [[ -z "$score" ]]; then
    printf '%s\n' "$security_output"
    fail 'systemd-analyze could not produce an exposure score'
  elif ! awk -v score="$score" 'BEGIN { exit !(score <= 2.0) }'; then
    fail "systemd exposure score $score is worse than the 2.0 ceiling"
  else
    systemd_version=$(systemd-analyze --version | sed -n '1p')
    verified_at=$(date -Iseconds)
    score_tmp="$score_path.tmp.$$"
    {
      printf 'keylab systemd security exposure score: %s\n' "$score"
      printf 'maximum accepted score: 2.0\n'
      printf 'systemd version: %s\n' "$systemd_version"
      printf 'verified at: %s\n' "$verified_at"
      printf 'unit: crates/keylab/keylab.service\n'
    } >"$score_tmp"
    mv -f -- "$score_tmp" "$score_path"
    pass "systemd exposure score is $score (maximum 2.0); recorded in docs/keylab-security-score.txt"
  fi
fi

printf '%s\n' 'Check 2: network capability and dependency leak'
network_failure=0
if [[ ! -x "$binary_path" ]]; then
  printf '%s\n' '  release binary is missing'
  network_failure=1
elif ! command -v nm >/dev/null 2>&1 || ! command -v objdump >/dev/null 2>&1; then
  printf '%s\n' '  both nm and objdump are required'
  network_failure=1
else
  symbol_hits=$(
    {
      nm -D --undefined-only "$binary_path"
      objdump -T "$binary_path"
    } 2>/dev/null | grep -Ei \
      '(^|[[:space:]_])(connect|socket|getaddrinfo)(@|$)|SSL_' | sort -u || true
  )
  if [[ -n "$symbol_hits" ]]; then
    printf '%s\n' '  networking symbol hits:'
    printf '%s\n' "$symbol_hits" | sed 's/^/    /'
    network_failure=1
  fi
fi

if [[ ! -f "$lock_path" ]]; then
  printf '%s\n' '  Cargo.lock is missing'
  network_failure=1
else
  crate_hits=$(
    awk '/^name = "/ { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); print name }' \
      "$lock_path" | grep -Ei \
      '^(reqwest|hyper|hyper-util|http|http-body|ureq|curl|curl-sys|native-tls|rustls|rustls-pki-types|tokio|tokio-net|tokio-native-tls|tokio-rustls|trust-dns.*|hickory.*|openssl|openssl-sys|boring|boring-sys|quinn|surf|isahc|attohttpc|dns-lookup|async-native-tls|async-tls|socket2)$' \
      || true
  )
  if [[ -n "$crate_hits" ]]; then
    printf '%s\n' '  HTTP/TLS/DNS dependency hits:'
    printf '%s\n' "$crate_hits" | sed 's/^/    /'
    network_failure=1
  fi
fi

for required_directive in \
  PrivateNetwork=yes \
  RestrictAddressFamilies=AF_UNIX \
  IPAddressDeny=any; do
  if ! grep -qxF "$required_directive" "$unit_path"; then
    printf '  missing unit enforcement: %s\n' "$required_directive"
    network_failure=1
  fi
done

if ((network_failure == 0)); then
  pass 'binary, dependency graph, and unit enforcement expose no network path'
else
  fail 'network capability or dependency leak detected'
fi

printf '%s\n' 'Check 3: private database modes and concurrent WAL reader'
db_dir="$verify_tmp/concurrent"
mkdir -m 0700 -- "$db_dir"
db_path="$db_dir/keylab.db"
writer_log="$verify_tmp/concurrent-writer.log"
KEYLAB_SELFTEST_KEYMAP_META="$keymap_path" \
  "$binary_path" --selftest-db "$db_path" >"$writer_log" 2>&1 &
writer_pid=$!

db_failure=0
if ! wait_for_writer "$writer_log"; then
  printf '%s\n' '  database writer did not become ready:'
  sed 's/^/    /' "$writer_log"
  db_failure=1
else
  reader_output=$("$binary_path" --selftest-db-reader "$db_path" 2>&1)
  reader_status=$?
  if ((reader_status != 0)) || [[ "$reader_output" != SELFTEST_DB_READ_OK* ]]; then
    printf '  read-only reader failed: %s\n' "$reader_output"
    db_failure=1
  fi

  invoking_uid=$(id -u)
  for owned_path in "$db_dir" "$db_path" "$db_path-wal" "$db_path-shm"; do
    if [[ ! -e "$owned_path" ]]; then
      printf '  expected WAL path is missing: %s\n' "$owned_path"
      db_failure=1
    elif [[ $(stat -c '%u' "$owned_path") != "$invoking_uid" ]]; then
      printf '  path is not owned by invoking user: %s\n' "$owned_path"
      db_failure=1
    fi
  done
  if [[ $(stat -c '%a' "$db_dir") != 700 ]]; then
    printf '  data directory mode is %s, expected 700\n' "$(stat -c '%a' "$db_dir")"
    db_failure=1
  fi
  if [[ $(stat -c '%a' "$db_path") != 600 ]]; then
    printf '  database mode is %s, expected 600\n' "$(stat -c '%a' "$db_path")"
    db_failure=1
  fi
fi
finish_writer

if ((db_failure == 0)); then
  pass 'database is user-owned with modes 0700/0600 and a second process reads WAL concurrently'
else
  fail 'database ownership, modes, or concurrent WAL reading is unsafe'
fi

printf '%s\n' 'Check 4: invoking account input-group membership (informational)'
invoking_user=${SUDO_USER:-${USER:-$(id -un)}}
invoking_groups=$(id -nG "$invoking_user")
if [[ " $invoking_groups " == *" input "* ]]; then
  printf "NOTE: account %s is in the input group; every process running as that account can read all input devices. SupplementaryGroups=input on keylab.service keeps keylab's own access scoped.\n" "$invoking_user"
else
  pass "account $invoking_user is not a persistent member of input"
fi

printf '%s\n' 'Check 5: maximum-verbosity fixture logs contain no key identity'
replay_dir="$verify_tmp/replay"
mkdir -m 0700 -- "$replay_dir"
replay_db="$replay_dir/keylab.db"
replay_log="$verify_tmp/replay.log"
KEYLAB_SELFTEST_KEYMAP_META="$keymap_path" RUST_LOG=trace \
  "$binary_path" --selftest-replay "$replay_db" >"$replay_log" 2>&1
replay_status=$?
leak_failure=0
if ((replay_status != 0)); then
  printf '%s\n' '  fixture replay failed:'
  sed 's/^/    /' "$replay_log"
  leak_failure=1
else
  replay_reader=$("$binary_path" --selftest-db-reader "$replay_db" 2>&1)
  if [[ "$replay_reader" != *'aggregate_rows=1'* ]]; then
    printf '  fixture did not persist the expected aggregate row: %s\n' "$replay_reader"
    leak_failure=1
  fi
  leak_hits=$(grep -Ein \
    "KEY_|keycode|pos=|position=|'([^'\\\\]|\\\\.)'" "$replay_log" || true)
  if [[ -n "$leak_hits" ]]; then
    printf '%s\n' '  key-identity-like log hits:'
    printf '%s\n' "$leak_hits" | sed 's/^/    /'
    leak_failure=1
  fi
fi

if ((leak_failure == 0)); then
  pass 'fixture replay succeeds at trace level without key-identity-like log output'
else
  fail 'fixture logging leaked identity or did not exercise persistence'
fi

printf '%s\n' 'Check 6: PAUSED discards the fixture'
paused_dir="$verify_tmp/paused"
mkdir -m 0700 -- "$paused_dir"
paused_db="$paused_dir/keylab.db"
touch -- "$paused_dir/PAUSED"
paused_log="$verify_tmp/paused.log"
KEYLAB_SELFTEST_KEYMAP_META="$keymap_path" RUST_LOG=trace \
  "$binary_path" --selftest-replay "$paused_db" >"$paused_log" 2>&1
paused_status=$?
paused_failure=0
if ((paused_status != 0)); then
  printf '%s\n' '  paused fixture replay failed:'
  sed 's/^/    /' "$paused_log"
  paused_failure=1
else
  paused_reader=$("$binary_path" --selftest-db-reader "$paused_db" 2>&1)
  if [[ "$paused_reader" != *'aggregate_rows=0'* ]]; then
    printf '  paused fixture wrote aggregate rows: %s\n' "$paused_reader"
    paused_failure=1
  fi
fi

if ((paused_failure == 0)); then
  pass 'PAUSED fixture replay writes zero aggregate rows'
else
  fail 'PAUSED did not suppress every aggregate write'
fi

if ((failures > 0)); then
  printf 'RESULT: FAIL (%d check%s failed)\n' "$failures" "$([[ $failures == 1 ]] && printf '' || printf 's')"
  exit 1
fi

printf '%s\n' 'RESULT: PASS (all runnable checks passed)'
