#!/usr/bin/env bash
# Scheduled on-host backups for the CoreCrow VPS (run as root by corecrow-backup.service). It never prints secrets.
#   - PostgreSQL: pg_dump -Fc of the production database, verified with pg_restore --list, checksummed, 14-day retention.
#   - MinIO: incremental mirror of the asset and dataset-import buckets (current versions) into a private directory.
# These copies live on the same machine. They protect against mistakes and bad deploys, NOT against losing the host:
# an OFF-HOST copy must be pulled or pushed to a separate provider (see docs/DATASET_IMPORT_VPS.md, "Backups").
set -euo pipefail
umask 077
root=/var/backups/blackpolar/scheduled
dataset_env=/etc/blackpolar/corecrow-dataset.env
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
install -d -m 0700 "$root/postgres" "$root/minio"

dump="$root/postgres/blackpolar-$stamp.dump"
docker exec corecrow-db pg_dump -U blackpolar -d blackpolar -Fc > "$dump"
entries="$(docker exec -i corecrow-db pg_restore --list < "$dump" | wc -l)"
[[ "$entries" -gt 20 ]] || { echo "PostgreSQL dump verification failed ($entries entries)" >&2; rm -f "$dump"; exit 1; }
(cd "$root/postgres" && sha256sum "$(basename "$dump")" >> SHA256SUMS)
find "$root/postgres" -name 'blackpolar-*.dump' -mtime +"$retention_days" -delete
echo "postgres: $(basename "$dump") entries=$entries bytes=$(stat -c %s "$dump")"

if docker inspect -f '{{.State.Running}}' corecrow-minio 2>/dev/null | grep -q true; then
  set -a; source "$dataset_env"; set +a
  chown -R 10001:10001 "$root/minio"
  for bucket in "$MINIO_ASSET_BUCKET" "$MINIO_BUCKET"; do
    docker run --rm --network "$CORECROW_DOCKER_NETWORK" --user 10001:10001 -v "$root/minio:/backup" \
      -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD --entrypoint /bin/sh "$MC_IMAGE" -ec '
        mc alias set corecrow http://corecrow-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
        mc mirror --preserve --quiet "corecrow/'"$bucket"'" "/backup/'"$bucket"'" >/dev/null'
    echo "minio: mirrored $bucket objects=$(find "$root/minio/$bucket" -type f 2>/dev/null | wc -l)"
  done
fi
