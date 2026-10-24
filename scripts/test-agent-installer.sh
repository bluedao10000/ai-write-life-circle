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
show) if [ -f "$WRITER_AGENT_INSTALL_ROOT/etc/systemd/system/${*: -1}.service" ]; then echo loaded; else echo not-found; fi ;;
is-active) test -f "$TEST_ROOT/active-${*: -1}" ;;
stop) rm -f "$TEST_ROOT/active-$2" ;;
restart|start)
  touch "$TEST_ROOT/active-$2"
  if [ "$2" = writer-agent-worker ] && [ ! -f "$TEST_ROOT/fail-worker" ]; then
    mkdir -p "$WRITER_AGENT_INSTALL_ROOT/var/lib/writer-agent/agent-runtime"
    python3 - <<'PY'
import os,json,datetime
p=os.environ['WRITER_AGENT_INSTALL_ROOT']+'/var/lib/writer-agent/agent-runtime/worker.json'
json.dump(dict(online=True,protocol='agent-runtime-v1',at=datetime.datetime.now(datetime.timezone.utc).isoformat()),open(p,'w'))
PY
  fi
  if [ "$2" = writer-agent-worker ] && [ -f "$TEST_ROOT/fail-worker" ]; then exit 1; fi
;;
esac
MOCK
cat > "$root/bin/curl" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$root/bin/tar" <<'MOCK'
#!/bin/bash
printf 'backup\n' >> "$TEST_ROOT/events"
[ ! -f "$TEST_ROOT/active-writer-agent-api" ] && [ ! -f "$TEST_ROOT/active-writer-agent-worker" ] || exit 91
exec /usr/bin/tar "$@"
MOCK
cat > "$root/input/api" <<'MOCK'
#!/bin/sh
case "$1" in --version) echo agent-runtime-v1 ;; --task-protocol) echo agent-tasks-v1 ;; esac
MOCK
cat > "$root/input/worker" <<'MOCK'
#!/bin/sh
case "$1" in
--version) echo agent-runtime-v1 ;;
--task-protocol) echo agent-tasks-v1 ;;
--check-config) test -n "$WRITER_AGENT_LLM_MODEL" && test -n "$WRITER_AGENT_LLM_API_KEY" && test -w "$WRITER_AGENT_STATE_DIR" ;;
esac
MOCK
chmod 0755 "$root/bin/"* "$root/input/"*
cat > "$root/input/worker.env" <<'ENV'
WRITER_AGENT_LLM_MODEL=synthetic-installer-only
WRITER_AGENT_LLM_BASE_URL=https://example.invalid/v1
WRITER_AGENT_LLM_API_KEY=synthetic-not-a-credential
ENV
chmod 0600 "$root/input/worker.env"
run_install() {
 bash scripts/deploy/install-api-systemd.sh "$root/input/api" "$1" author scripts/deploy/systemd/writer-agent-api.service "$root/input/worker" scripts/deploy/systemd/writer-agent-worker.service "$root/input/worker.env"
}
# Fresh install must preflight without an API token or HTTP listener.
run_install aaaaaaa
! grep -q 'synthetic-not-a-credential' "$root/target/etc/writer-agent/api.env"
test -s "$root/target/opt/writer-agent/releases/aaaaaaa/SHA256SUMS"
printf 'author revision\n' > "$root/target/var/lib/writer-agent/prose"
# Upgrade must explicitly restart both services; backup sees both stopped.
: > "$root/events"
run_install bbbbbbb
grep -q '^restart writer-agent-worker$' "$root/events"
# Failure must stop Worker before restarting old API; preserve prose and old pair.
touch "$root/fail-worker"
if run_install ccccccc; then echo 'Expected worker failure' >&2; exit 1; fi
test "$(readlink "$root/target/opt/writer-agent/current")" = "$root/target/opt/writer-agent/releases/bbbbbbb"
test "$(cat "$root/target/var/lib/writer-agent/prose")" = 'author revision'
python3 - "$root/events" <<'PY'
import sys
lines=open(sys.argv[1]).read().splitlines()
last_api=max(i for i,v in enumerate(lines) if v=='restart writer-agent-api')
assert 'stop writer-agent-worker' in lines[:last_api]
assert lines.index('stop writer-agent-worker')<lines.index('backup')
PY
rm -f "$root/fail-worker"
# A legacy API rollback must never start the new Worker beside embedded agents.
legacy=$root/target/opt/writer-agent/releases/legacy
mkdir -p "$legacy";cp "$root/input/api" "$legacy/writer-agent-api"
ln -sfn "$legacy" "$root/target/opt/writer-agent/current"
rm -f "$root/active-writer-agent-worker"
touch "$root/fail-worker"
: > "$root/events"
if run_install ddddddd; then exit 1; fi
python3 - "$root/events" <<'PY'
import sys
lines=open(sys.argv[1]).read().splitlines();i=max(i for i,v in enumerate(lines) if v=='restart writer-agent-api')
assert 'restart writer-agent-worker' not in lines[i+1:]
PY
# Once task ownership exists, Pi-owned releases cannot enter the Go-only installer.
mkdir -p "$root/target/var/lib/writer-agent/agent-runtime"
policy=$root/target/var/lib/writer-agent/agent-runtime/executors-v1.json
printf '%s\n' '{"schema":1,"kinds":{"review":{"owner":"pi"},"knowledge":{"owner":"go"}}}' > "$policy"
: > "$root/events"
if run_install eeeeeee; then exit 1; fi
test ! -s "$root/events"
# Ownership-aware state must never restart an incompatible legacy rollback pair.
printf '%s\n' '{"schema":1,"kinds":{"review":{"owner":"go"},"knowledge":{"owner":"go"}}}' > "$policy"
: > "$root/events"
if run_install fffffff; then exit 1; fi
[ "$(grep -c '^restart writer-agent-api$' "$root/events")" = 1 ]
test "$(cat "$root/target/var/lib/writer-agent/prose")" = 'author revision'
# Incompatible pair rejected before services stop.
cat > "$root/input/worker" <<'MOCK'
#!/bin/sh
echo incompatible
MOCK
: > "$root/events"
if run_install eeeeeee; then exit 1; fi
test ! -s "$root/events"
echo 'Installer: fresh install, pair upgrade, both-writer backup, failed-worker rollback, legacy single-executor rollback and incompatible pair checks passed.'
