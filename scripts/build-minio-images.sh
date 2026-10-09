#!/usr/bin/env bash
# Builds MinIO and mc from their official source tags (see deploy/minio-from-source/Dockerfile) and prints the immutable
# local image IDs to put in /etc/blackpolar/corecrow-dataset.env as MINIO_IMAGE and MC_IMAGE. Run on the VPS.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
context="$here/deploy/minio-from-source"
minio_tag="$(sed -n 's/^ARG MINIO_TAG=//p' "$context/Dockerfile" | tr -d '')"
mc_tag="$(sed -n 's/^ARG MC_TAG=//p' "$context/Dockerfile" | tr -d '')"
sudo -n docker build --pull=false --target minio -t "corecrow-minio:$minio_tag" "$context"
sudo -n docker build --target mc -t "corecrow-mc:$mc_tag" "$context"
echo "MINIO_IMAGE=$(sudo -n docker image inspect --format '{{.Id}}' "corecrow-minio:$minio_tag")"
echo "MC_IMAGE=$(sudo -n docker image inspect --format '{{.Id}}' "corecrow-mc:$mc_tag")"
