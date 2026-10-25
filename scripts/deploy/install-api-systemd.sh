#!/bin/bash
# Tested dual-process releases only. Never restore a state backup over new prose.
set -euo pipefail
if [ "$(id -u)" != 0 ] || [ "$#" -lt 6 ] || [ "$#" -gt 7 ]; then
  echo 'Usage (root): install-api-systemd.sh API RELEASE_ID AUTHOR API_UNIT WORKER WORKER_UNIT [WORKER_ENV]' >&2
  exit 1
fi
binary=$(realpath "$1"); release_id=$2; author=$3; unit=$(realpath "$4")
worker_binary=$(realpath "$5"); worker_unit=$(realpath "$6")
# A staging root is supported for isolated installer contract tests.
prefix=${WRITER_AGENT_INSTALL_ROOT:-}
base=$prefix/opt/writer-agent
config=$prefix/etc/writer-agent
state=$prefix/var/lib/writer-agent
units=$prefix/etc/systemd/system
harness=$prefix/srv/writer-agent/harness
[[ "$release_id" =~ ^[a-f0-9]{7,40}$ ]] || { echo 'Invalid release commit' >&2; exit 1; }
[[ "$author" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || { echo 'Invalid author ID' >&2; exit 1; }
for file in "$binary" "$unit" "$worker_binary" "$worker_unit"; do test -f "$file"; done
[ "$("$binary" --version)" = agent-runtime-v1 ] && [ "$("$worker_binary" --version)" = agent-runtime-v1 ] || { echo 'Incompatible API/Worker protocol' >&2; exit 1; }
# Existing ownership means old binaries cannot safely interpret task state.
if [ -f "$state/agent-runtime/executors-v1.json" ]; then
  [ "$("$binary" --task-protocol)" = agent-tasks-v1 ] && [ "$("$worker_binary" --task-protocol)" = agent-tasks-v1 ] || { echo 'Ownership-aware API/Worker required; services unchanged.' >&2; exit 1; }
  python3 - "$state/agent-runtime/executors-v1.json" <<'PYOWNER'
import json,sys
s=json.load(open(sys.argv[1]))
if s.get('schema')!=1 or any(s.get('kinds',{}).get(k,{}).get('owner')!='go' or s['kinds'][k].get('draining') for k in ('review','knowledge')):
 raise SystemExit('Go-only installer refuses Pi/disabled/draining ownership. Use the manual fenced rollback first; services unchanged.')
PYOWNER
fi
worker_env=${7:-$config/worker.env}
test -f "$worker_env" || { echo 'Provide a protected Worker env with LLM settings; no services were stopped.' >&2; exit 1; }
id writer-agent >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/writer-agent --shell /usr/sbin/nologin writer-agent
install -d -m 0755 "$base/releases" "$harness" "$units"
install -d -m 0750 -o root -g writer-agent "$config"
install -d -m 0700 -o writer-agent -g writer-agent "$state"
install -d -m 0700 "$prefix/var/backups/writer-agent"
# Parse systemd-style KEY=value files, never shell-evaluate credentials or put them in argv.
# Preflight under the service identity before stopping anything. API metadata is
# derived from the validated Worker config, and never receives its API key.
python3 - "$worker_env" "$config" "$state" "$harness" "$author" "$worker_binary" <<'PYCFG'
import os,pwd,shlex,subprocess,sys,tempfile
source,config,state,harness,author,binary=sys.argv[1:]
def read(path):
    out={}
    if os.path.exists(path):
        for line in open(path):
            line=line.strip()
            if not line or line.startswith('#'): continue
            k,sep,v=line.partition('=')
            if not sep or not k.replace('_','').isalnum(): raise SystemExit('Invalid environment file')
            values=shlex.split(v); out[k]=' '.join(values)
    return out
worker=read(source)
worker.update(WRITER_AGENT_ENV='production',WRITER_AGENT_AUTHOR_ID=author,WRITER_AGENT_STATE_DIR=state,WRITER_AGENT_HARNESS_ROOT=harness)
api=read(config+'/api.env')
if api.get('WRITER_AGENT_AUTHOR_ID',author)!=author: raise SystemExit('Author identity mismatch; services unchanged')
# Per-user identity: the API refuses to start without the Worker's public key.
if not api.get('WRITER_AGENT_IDENTITY_PUBLIC_KEY','').strip(): raise SystemExit('Add WRITER_AGENT_IDENTITY_PUBLIC_KEY (and WRITER_AGENT_LEGACY_OWNER_EMAIL) to api.env first; services unchanged')
api={k:v for k,v in api.items() if not k.startswith('WRITER_AGENT_LLM_') and k!='WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS'}
project=api.get('WRITER_AGENT_PROJECT_ID',worker.get('WRITER_AGENT_PROJECT_ID','local'))
worker['WRITER_AGENT_PROJECT_ID']=project
worker.pop('WRITER_AGENT_AUTH_TOKEN_FILE',None)
api.update({k:v for k,v in worker.items() if k.startswith('WRITER_AGENT_LLM_') and k!='WRITER_AGENT_LLM_API_KEY' or k=='WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS'})
# Key-only DeepSeek configuration must have the same public defaults in API.
api.setdefault('WRITER_AGENT_LLM_PROVIDER','openai-compatible')
api.update(WRITER_AGENT_ENV='production',WRITER_AGENT_AUTH_MODE='bearer',WRITER_AGENT_AUTH_TOKEN_FILE=config+'/auth-token',WRITER_AGENT_AUTHOR_ID=author,WRITER_AGENT_PROJECT_ID=project,WRITER_AGENT_API_HOST='127.0.0.1',WRITER_AGENT_API_PORT='8787',WRITER_AGENT_HARNESS_ROOT=harness,WRITER_AGENT_STATE_DIR=state)
api.pop('WRITER_AGENT_LLM_API_KEY',None)
user=pwd.getpwnam('writer-agent')
def demote():
    os.setgroups([]);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
env={'PATH':os.environ['PATH'],'HOME':state,**worker}
result=subprocess.run([binary,'--check-config'],env=env,preexec_fn=demote,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode: raise SystemExit('Worker preflight failed; verify model, author, state and registry. Services unchanged.')
for name,values in [('api.env.next',api),('worker.env.next',worker)]:
    fd=os.open(config+'/'+name,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:
        for k,v in values.items(): f.write(k+'="'+v.replace('\\','\\\\').replace('"','\\"')+'"\n')
PYCFG
release=$base/releases/$release_id
if [ -e "$release" ]; then
  cmp "$binary" "$release/writer-agent-api"
  cmp "$worker_binary" "$release/writer-agent-worker"
fi
previous=$(readlink -f "$base/current" || true)
backup=$(mktemp -d "$prefix/var/backups/writer-agent/deploy-XXXXXXXX")
previous_worker=false
if systemctl is-active --quiet writer-agent-worker; then previous_worker=true; fi
rollback() {
  result=$?
  if [ "$result" -ne 0 ]; then
    # Stop the new executor before any legacy API (with embedded agents) starts.
    systemctl stop writer-agent-worker || true
    systemctl stop writer-agent-api || true
    if [ -n "$previous" ] && [ -x "$previous/writer-agent-api" ]; then
      ln -sfn "$previous" "$base/current.rollback"; mv -Tf "$base/current.rollback" "$base/current"
      for name in writer-agent-api.service writer-agent-worker.service; do
        if [ -f "$backup/$name" ]; then cp -a "$backup/$name" "$units/$name"; else rm -f "$units/$name"; fi
      done
      if [ -d "$backup/config" ]; then cp -a "$backup/config/." "$config/"; fi
      systemctl daemon-reload
      safe_previous=true
      if [ -f "$state/agent-runtime/executors-v1.json" ]; then
        if [ "$("$previous/writer-agent-api" --task-protocol 2>/dev/null || true)" != agent-tasks-v1 ] || [ ! -x "$previous/writer-agent-worker" ] || [ "$("$previous/writer-agent-worker" --task-protocol 2>/dev/null || true)" != agent-tasks-v1 ]; then
          safe_previous=false
          echo 'Previous release cannot honor executor ownership. API/Go Worker remain stopped; deploy a compatible pair manually.' >&2
        fi
      fi
      if $safe_previous; then systemctl restart writer-agent-api || true; fi
      if $safe_previous && $previous_worker && [ -x "$previous/writer-agent-worker" ]; then systemctl restart writer-agent-worker || true; fi
    fi
    echo "Deployment failed. Binaries/config restored; application data retained. Backup: $backup" >&2
  fi
}
# Configuration/unit snapshots precede the trap, so even a stop failure can
# restore the actual previous deployment rather than treating absent backups as absent units.
cp -a "$config" "$backup/config"
for name in writer-agent-api.service writer-agent-worker.service; do
  [ ! -f "$units/$name" ] || cp -a "$units/$name" "$backup/"
done
trap rollback EXIT
stop_if_installed() {
  if [ "$(systemctl show --property=LoadState --value "$1")" != not-found ]; then systemctl stop "$1"; fi
}
stop_if_installed writer-agent-worker
stop_if_installed writer-agent-api
# Both writers are now stopped; O_EXCL orphan locks are never deleted by age.
tar -C "$(dirname "$state")" -czf "$backup/state.tar.gz" "$(basename "$state")"
printf '%s\n' "$previous" > "$backup/previous-release"
if [ ! -e "$config/auth-token" ]; then
  python3 - "$config/auth-token" <<'PYTOKEN'
import os,secrets,sys
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
with os.fdopen(fd,'w') as f:f.write(secrets.token_hex(32)+'\n')
PYTOKEN
  chown root:writer-agent "$config/auth-token"; chmod 0640 "$config/auth-token"
fi
if [ ! -e "$release" ]; then
  install -d -m 0755 "$release"
  install -m 0755 "$binary" "$release/writer-agent-api"
  install -m 0755 "$worker_binary" "$release/writer-agent-worker"
fi
(cd "$release" && sha256sum writer-agent-api writer-agent-worker > SHA256SUMS)
printf 'protocol=agent-runtime-v1\nrelease=%s\n' "$release_id" > "$release/manifest"
mv "$config/api.env.next" "$config/api.env"; mv "$config/worker.env.next" "$config/worker.env"
install -m 0644 "$unit" "$units/writer-agent-api.service"
install -m 0644 "$worker_unit" "$units/writer-agent-worker.service"
ln -sfn "$release" "$base/current.next"; mv -Tf "$base/current.next" "$base/current"
systemctl daemon-reload
systemctl enable writer-agent-api writer-agent-worker
systemctl restart writer-agent-api
healthy=false
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null; then healthy=true; break; fi
  sleep 1
done
$healthy || { echo 'API health check failed' >&2; exit 1; }
worker_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
systemctl restart writer-agent-worker
# Validate an actual new heartbeat; is-active alone can hide startup failures.
for attempt in $(seq 1 20); do
  if systemctl is-active --quiet writer-agent-worker && python3 - "$state/agent-runtime/worker.json" "$worker_started_at" <<'PYHEALTH'
import json,sys,datetime
try:
 s=json.load(open(sys.argv[1]));at=datetime.datetime.fromisoformat(s['at'].replace('Z','+00:00'))
 assert s['online'] and s['protocol']=='agent-runtime-v1' and at>=datetime.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00')) and (datetime.datetime.now(datetime.timezone.utc)-at).total_seconds()<5
except Exception: sys.exit(1)
PYHEALTH
  then
    echo "API and Worker healthy. Release: $release_id; backup: $backup"
    exit 0
  fi
  sleep 1
done
echo 'Worker heartbeat check failed' >&2
exit 1
