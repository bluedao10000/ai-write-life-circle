#!/bin/bash
# Runs only in an isolated Linux CI runner; never connects to a host.
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo 'Installer test requires isolated Linux root'; exit 1; }
repo=$(pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
chmod 0755 "$root"
mkdir -p "$root/bin" "$root/input"
export WRITER_AGENT_INSTALL_ROOT=$root/target TEST_ROOT=$root
export PATH="$root/bin:$PATH"
cat > "$root/bin/systemctl" <<'MOCK'
#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$TEST_ROOT/events"
case "$1" in
show) if [ -f "$WRITER_AGENT_INSTALL_ROOT/etc/systemd/system/${*: -1}" ]; then echo loaded; else echo not-found; fi ;;
is-active) test -f "$TEST_ROOT/active-${*: -1}" ;;
disable) rm -f "$TEST_ROOT/active-$3" ;;
stop) rm -f "$TEST_ROOT/active-$2" ;;
restart|enable) touch "$TEST_ROOT/active-$2" ;;
daemon-reload) ;;
esac
MOCK
cat > "$root/bin/curl" <<'MOCK'
#!/bin/sh
test ! -f "$TEST_ROOT/fail-api"
MOCK
cat > "$root/bin/tar" <<'MOCK'
#!/bin/bash
printf 'backup\n' >> "$TEST_ROOT/events"
[ ! -f "$TEST_ROOT/active-writer-agent-api" ] || exit 91
exec /usr/bin/tar "$@"
MOCK
cat > "$root/input/api" <<'MOCK'
#!/bin/sh
case "$1" in --version) echo writer-agent-api-v1 ;; --task-protocol) echo agent-tasks-v1 ;; esac
MOCK
printf '#!/bin/sh\nexit 0\n' > "$root/input/control"
chmod 0755 "$root/bin/"* "$root/input/"*
run_install() {
  bash scripts/deploy/install-api-systemd.sh "$root/input/api" "$1" author scripts/deploy/systemd/writer-agent-api.service "$root/input/control"
}

# Missing api.env must refuse before any service operation.
: > "$root/events"
if run_install aaaaaaa; then echo 'Expected missing API environment refusal' >&2; exit 1; fi
test ! -s "$root/events"

mkdir -p "$root/target/etc/writer-agent"
cat > "$root/target/etc/writer-agent/api.env" <<'ENV'
WRITER_AGENT_ENV=production
WRITER_AGENT_AUTH_MODE=bearer
WRITER_AGENT_AUTHOR_ID=author
WRITER_AGENT_IDENTITY_PUBLIC_KEY=MCowBQYDK2VwAyEAsyntheticinstalleronly0000000=
WRITER_AGENT_TASK_SERVICE_TOKEN_FILE=/etc/writer-agent-pi-task-rpc/service.token
WRITER_AGENT_LLM_PROVIDER=openai-compatible
WRITER_AGENT_LLM_BASE_URL=https://example.invalid/v1
WRITER_AGENT_LLM_MODEL=synthetic-installer-only
ENV

# A legacy Go worker is retired before the API backup and restart window.
mkdir -p "$root/target/etc/systemd/system"
printf 'legacy\n' > "$root/target/etc/systemd/system/writer-agent-worker.service"
touch "$root/active-writer-agent-worker"
: > "$root/events"
run_install aaaaaaa
grep -q '^disable --now writer-agent-worker.service$' "$root/events"
test ! -f "$root/target/etc/systemd/system/writer-agent-worker.service"
test ! -f "$root/active-writer-agent-worker"
test -s "$root/target/opt/writer-agent/releases/aaaaaaa/SHA256SUMS"
grep -q '^enable writer-agent-api$' "$root/events"
python3 - "$root/events" <<'PY'
import sys
lines=open(sys.argv[1]).read().splitlines()
assert lines.index('disable --now writer-agent-worker.service') < lines.index('backup')
assert 'restart writer-agent-api' in lines
PY

printf 'author revision\n' > "$root/target/var/lib/writer-agent/prose"
: > "$root/events"
run_install bbbbbbb
grep -q '^restart writer-agent-api$' "$root/events"

# A failed health check restores the last compatible API and keeps newer data.
touch "$root/target/var/lib/writer-agent/newer-data"
touch "$root/fail-api"
: > "$root/events"
if run_install ccccccc; then echo 'Expected API health failure' >&2; exit 1; fi
test "$(readlink "$root/target/opt/writer-agent/current")" = "$root/target/opt/writer-agent/releases/bbbbbbb"
test "$(cat "$root/target/var/lib/writer-agent/prose")" = 'author revision'
test -f "$root/target/var/lib/writer-agent/newer-data"
test "$(grep -c '^restart writer-agent-api$' "$root/events")" -ge 2
rm -f "$root/fail-api"

# Incompatible binaries are rejected before services are touched.
cat > "$root/input/api" <<'MOCK'
#!/bin/sh
case "$1" in --version) echo agent-runtime-v1 ;; --task-protocol) echo legacy ;; esac
MOCK
chmod 0755 "$root/input/api"
: > "$root/events"
if run_install ddddddd; then exit 1; fi
test ! -s "$root/events"
echo 'Installer: API-only fresh install, legacy Go worker retirement, upgrade, health rollback and protocol rejection passed.'
