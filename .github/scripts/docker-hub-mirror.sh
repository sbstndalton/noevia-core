#!/usr/bin/env bash
# Route the runner's Docker daemon's docker.io pulls through Google's pull-through mirror
# (anonymous Docker Hub pulls hit 429; noevia #1221). Image references and pinned digests are
# untouched (digests are verified against the manifest either way); the daemon falls back to
# docker.io itself when the mirror lacks an image or errors.
set -euo pipefail
cfg=/etc/docker/daemon.json
[ -f "$cfg" ] || echo '{}' | sudo tee "$cfg" >/dev/null
tmp=$(mktemp)
jq '. + {"registry-mirrors": ["https://mirror.gcr.io"]}' "$cfg" > "$tmp"
sudo install -m 0644 "$tmp" "$cfg"
sudo systemctl restart docker
docker info --format '{{json .RegistryConfig.Mirrors}}'
