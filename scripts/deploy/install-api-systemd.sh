#!/bin/bash
# API-only release installer. Pi Thinking and Pi Worker have separate releases.
set -euo pipefail
if [ "$(id -u)" != 0 ] || [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo 'Usage (root): install-api-systemd.sh API RELEASE_ID AUTHOR API_UNIT [CONTROL]' >&2
  exit 1
fi
binary=$(realpath "$1")
release_id=$2
author=$3
unit=$(realpath "$4")
control=${5:+$(realpath "$5")}
# A staging root is supported for isolated installer contract tests.
prefix=${WRITER_AGENT_INSTALL_ROOT:-}
base=$prefix/opt/writer-agent
config=$prefix/etc/writer-agent
state=$prefix/var/lib/writer-agent
units=$prefix/etc/systemd/system
harness=$prefix/srv/writer-agent/harness
[[ "$release_id" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid release commit' >&2; exit 1; }
[[ "$author" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || { echo 'Invalid author ID' >&2; exit 1; }
for file in "$binary" "$unit" ${control:+"$control"}; do test -f "$file"; done
[ "$("$binary" --version)" = writer-agent-api-v1 ] && [ "$("$binary" --task-protocol)" = agent-tasks-v1 ] || {
  echo 'API must support the Pi task protocol' >&2
  exit 1
}
id writer-agent >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/writer-agent --shell /usr/sbin/nologin writer-agent
install -d -m 0755 "$base/releases" "$harness" "$units"
install -d -m 0750 -o root -g writer-agent "$config"
install -d -m 0700 -o writer-agent -g writer-agent "$state"
install -d -m 0700 "$prefix/var/backups/writer-agent"

api_env=$config/api.env
if [ ! -f "$api_env" ]; then
  echo "Create $api_env with identity, bearer, task-service and public model settings first." >&2
  exit 1
fi
python3 - "$api_env" "$author" <<'PYENV'
import shlex,sys
path,author=sys.argv[1:]
values={}
for line in open(path):
    line=line.strip()
    if not line or line.startswith('#'): continue
    key,sep,value=line.partition('=')
    if not sep or not key.replace('_','').isalnum(): raise SystemExit('Invalid API environment file')
    values[key]=' '.join(shlex.split(value))
required=('WRITER_AGENT_ENV','WRITER_AGENT_AUTH_MODE','WRITER_AGENT_AUTHOR_ID','WRITER_AGENT_IDENTITY_PUBLIC_KEY','WRITER_AGENT_TASK_SERVICE_TOKEN_FILE')
missing=[key for key in required if not values.get(key,'').strip()]
if missing: raise SystemExit('Missing API settings: '+', '.join(missing)+'; services unchanged.')
if values['WRITER_AGENT_ENV']!='production' or values['WRITER_AGENT_AUTH_MODE']!='bearer':
    raise SystemExit('API environment must be production bearer mode; services unchanged.')
if values['WRITER_AGENT_AUTHOR_ID']!=author: raise SystemExit('Author identity mismatch; services unchanged.')
PYENV

release=$base/releases/$release_id
if [ -e "$release" ]; then
  cmp "$binary" "$release/writer-agent-api"
  [ -z "$control" ] || cmp "$control" "$release/writer-agent-control"
fi
previous=$(readlink -f "$base/current" || true)
backup=$(mktemp -d "$prefix/var/backups/writer-agent/deploy-XXXXXXXX")
cp -a "$config" "$backup/config"
[ ! -f "$units/writer-agent-api.service" ] || cp -a "$units/writer-agent-api.service" "$backup/"
printf '%s\n' "$previous" > "$backup/previous-release"
rollback() {
  result=$?
  if [ "$result" -ne 0 ]; then
    systemctl stop writer-agent-api || true
    if [ -n "$previous" ] && [ -x "$previous/writer-agent-api" ] && [ "$("$previous/writer-agent-api" --task-protocol 2>/dev/null || true)" = agent-tasks-v1 ]; then
      ln -sfn "$previous" "$base/current.rollback"
      mv -Tf "$base/current.rollback" "$base/current"
      if [ -f "$backup/writer-agent-api.service" ]; then cp -a "$backup/writer-agent-api.service" "$units/"; else rm -f "$units/writer-agent-api.service"; fi
      if [ -d "$backup/config" ]; then cp -a "$backup/config/." "$config/"; fi
      systemctl daemon-reload
      systemctl restart writer-agent-api || true
    fi
    echo "Deployment failed. Previous compatible API restored where possible; application data retained. Backup: $backup" >&2
  fi
}
trap rollback EXIT

# Go model execution has been removed. Retirement is part of every API install,
# so a stale unit can never race the Pi executor for a durable lease.
legacy_unit=writer-agent-worker.service
if [ "$(systemctl show --property=LoadState --value "$legacy_unit")" != not-found ]; then
  systemctl disable --now "$legacy_unit" || true
fi
rm -f "$units/$legacy_unit"
systemctl stop writer-agent-api || true
tar -C "$(dirname "$state")" -czf "$backup/state.tar.gz" "$(basename "$state")"

if [ ! -e "$config/auth-token" ]; then
  python3 - "$config/auth-token" <<'PYTOKEN'
import os,secrets,sys
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
with os.fdopen(fd,'w') as f:f.write(secrets.token_hex(32)+'\n')
PYTOKEN
  chown root:writer-agent "$config/auth-token"
  chmod 0640 "$config/auth-token"
fi
if [ ! -e "$release" ]; then
  install -d -m 0755 "$release"
  install -m 0755 "$binary" "$release/writer-agent-api"
  [ -z "$control" ] || install -m 0755 "$control" "$release/writer-agent-control"
fi
if [ -n "$control" ]; then
  (cd "$release" && sha256sum writer-agent-api writer-agent-control > SHA256SUMS)
else
  (cd "$release" && sha256sum writer-agent-api > SHA256SUMS)
fi
printf 'protocol=agent-tasks-v1\nrelease=%s\n' "$release_id" > "$release/manifest"
install -m 0644 "$unit" "$units/writer-agent-api.service"
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
systemctl daemon-reload
systemctl enable writer-agent-api
systemctl restart writer-agent-api
healthy=false
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null; then healthy=true; break; fi
  sleep 1
done
$healthy || { echo 'API health check failed' >&2; exit 1; }
echo "API healthy; legacy Go worker retired. Release: $release_id; backup: $backup"
