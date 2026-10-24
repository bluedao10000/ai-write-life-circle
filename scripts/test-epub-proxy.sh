#!/usr/bin/env bash
set -euo pipefail
# Keep this version aligned with the production Caddy edge (v2.11.7).
version=2.11.7
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux_amd64 ;;
  Darwin/arm64) platform=mac_arm64 ;;
  *) echo 'Set CADDY_BIN manually for this platform' >&2; exit 1 ;;
esac
repo_root=$(cd "$(dirname "$0")/.." && pwd)
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
archive="caddy_${version}_${platform}.tar.gz"
base="https://github.com/caddyserver/caddy/releases/download/v${version}"
curl --fail --silent --show-error --location "$base/$archive" -o "$task_dir/$archive"
curl --fail --silent --show-error --location "$base/caddy_${version}_checksums.txt" -o "$task_dir/checksums.txt"
(cd "$task_dir"; awk -v archive="$archive" '$2 == archive || $2 == "*" archive' checksums.txt > selected-checksum.txt; shasum -a 256 -c selected-checksum.txt; tar -xzf "$archive" caddy)
CADDY_BIN="$task_dir/caddy" go test -C "$repo_root/apps/api-go" ./internal/transport -run '^TestEPUBCaddyUploadBoundary$' -count=1 -v
