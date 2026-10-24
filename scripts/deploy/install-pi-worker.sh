#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} != --confirm-install ]]; then
  echo 'Manual installation only: sudo bash scripts/deploy/install-pi-worker.sh --confirm-install' >&2
  exit 2
fi
[[ $(id -u) -eq 0 ]] || { echo 'Run as root on the intended host' >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
getent group writer-agent-pi-task-rpc >/dev/null || groupadd --system writer-agent-pi-task-rpc
id writer-agent-pi-worker >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin writer-agent-pi-worker
install -d -o root -g writer-agent-pi-task-rpc -m 0750 /etc/writer-agent-pi-task-rpc
if [[ ! -e /etc/writer-agent-pi-task-rpc/service.token ]]; then
  token_file=$(mktemp /etc/writer-agent-pi-task-rpc/.token.XXXXXX)
  trap 'rm -f -- "$token_file"' EXIT
  openssl rand -hex 32 > "$token_file"
  chown root:writer-agent-pi-task-rpc "$token_file"
  chmod 0640 "$token_file"
  mv -T -- "$token_file" /etc/writer-agent-pi-task-rpc/service.token
fi
install -d -o root -g writer-agent-pi-worker -m 0750 /etc/writer-agent-pi-worker
if [[ ! -e /etc/writer-agent-pi-worker/worker.env ]]; then
  install -o root -g writer-agent-pi-worker -m 0640 "$script_dir/pi-worker.env.example" /etc/writer-agent-pi-worker/worker.env
fi
install -d -m 0755 /etc/systemd/system/writer-agent-api.service.d
cat > /etc/systemd/system/writer-agent-api.service.d/pi-tasks.conf <<'DROPIN'
[Service]
SupplementaryGroups=writer-agent-pi-task-rpc
DROPIN
install -m 0644 "$script_dir/systemd/writer-agent-pi-worker.service" /etc/systemd/system/writer-agent-pi-worker.service
systemctl daemon-reload
echo 'Installed without starting services or changing ownership. Configure protected model environment, deploy matching binaries, and follow harness/workflows/pi-worker.md before starting or switching.'
