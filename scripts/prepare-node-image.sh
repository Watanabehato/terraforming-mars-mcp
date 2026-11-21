#!/usr/bin/env sh
# Pre-pull the Node 26 base image through the configured Docker Hub mirror and
# tag it under its canonical name so the unmodified upstream Dockerfile can
# use it. Run this once before `docker compose up --build` when Docker Hub is
# slow or blocked.
set -eu

MIRROR="${MIRROR:-ssw29qyeeou949jadc.xuanyuan.run/library/node:26-alpine3.23}"
LOCAL="${LOCAL:-node:26-alpine3.23}"

docker pull "$MIRROR"
docker tag "$MIRROR" "$LOCAL"
printf 'tagged %s as %s\n' "$MIRROR" "$LOCAL"
