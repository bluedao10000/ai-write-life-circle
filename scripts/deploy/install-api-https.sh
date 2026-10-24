#!/bin/bash
# Adapt the existing greenfield nginx HTTP edge without replacing its Web routes.
set -euo pipefail
if [ "$(id -u)" != 0 ] || [ "$#" != 6 ]; then
  echo 'Usage (root): install-api-https.sh DOMAIN NGINX_CONFIG COMPOSE_FILE CADDYFILE NGINX_TEMPLATE CADDY_IMAGE_DIGEST' >&2
  exit 1
fi
domain=$1
nginx_config=$(realpath "$2")
compose=$(realpath "$3")
caddyfile=$(realpath "$4")
template=$(realpath "$5")
image=$6
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] || { echo 'Invalid domain' >&2; exit 1; }
[[ "$image" =~ ^caddy@sha256:[a-f0-9]{64}$ ]] || { echo 'Use a pinned official Caddy digest' >&2; exit 1; }
gateway=$(docker network inspect greenfield-net --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}' | head -1)
[[ "$gateway" =~ ^[0-9.]+$ ]] || { echo 'Missing nginx network gateway' >&2; exit 1; }
install -d -m 0755 /opt/writer-agent/edge
install -d -m 0750 /etc/writer-agent
install -d -m 0700 /var/backups/writer-agent /var/lib/writer-agent-caddy/data /var/lib/writer-agent-caddy/config
backup=$(mktemp -d /var/backups/writer-agent/https-XXXXXXXX)
cp -a "$nginx_config" "$backup/nginx.conf"
[ ! -f /etc/writer-agent/Caddyfile ] || cp -a /etc/writer-agent/Caddyfile "$backup/"
[ ! -f /etc/writer-agent/edge.env ] || cp -a /etc/writer-agent/edge.env "$backup/"
install -m 0644 "$compose" /opt/writer-agent/edge/compose.yml
install -m 0644 "$caddyfile" /etc/writer-agent/Caddyfile
umask 077
printf 'CADDY_IMAGE=%s\nWRITER_AGENT_API_DOMAIN=%s\n' "$image" "$domain" > /etc/writer-agent/edge.env
docker run --rm --network host --entrypoint caddy -e "WRITER_AGENT_API_DOMAIN=$domain" -v /etc/writer-agent/Caddyfile:/etc/caddy/Caddyfile:ro "$image" validate --config /etc/caddy/Caddyfile >/dev/null
python3 - "$nginx_config" "$template" "$domain" "$gateway" <<'PY'
import sys,re
from pathlib import Path
path,template,domain,gateway=sys.argv[1:]
p=Path(path)
old=p.read_text()
old=re.sub(r'\n?# BEGIN Writer Agent API\n.*?# END Writer Agent API\n?', '', old, flags=re.S)
block=Path(template).read_text().replace('@DOMAIN@',domain).replace('@HOST_GATEWAY@',gateway)
# Write in place: the existing nginx container bind-mounts this exact file inode.
p.write_text(old.rstrip()+'\n\n'+block)
PY
if ! docker exec greenfield-nginx nginx -t; then
  cat "$backup/nginx.conf" > "$nginx_config"
  exit 1
fi
docker exec greenfield-nginx nginx -s reload
docker compose --env-file /etc/writer-agent/edge.env -f /opt/writer-agent/edge/compose.yml up -d --force-recreate
echo "HTTPS edge started for $domain. Backup: $backup. Verify certificate, redirect and auth from outside the host."
