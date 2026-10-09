#!/usr/bin/env bash
# Disposable XLSX pipeline smoke on the VPS. It starts an ISOLATED CoreCrow API + worker with their own throwaway PostgreSQL
# (nothing touches the production database or accounts) that use the real private MinIO and ClamAV, then drives the whole
# upload -> ClamAV -> OOXML validation -> analysis -> mapping -> activation -> query flow plus negative cases with
# scripts/smoke-xlsx-driver.mjs. Run as root on the VPS:
#   bash scripts/smoke-xlsx-stack.sh <corecrow-api image> <dir with node_modules + scripts> <fixtures dir>
# Secrets are read from /etc/blackpolar/corecrow.env into a 0600 file and never printed.
set -euo pipefail
image="${1:?CoreCrow API image}"; work="${2:?work dir}"; fixtures="${3:?fixtures dir}"
net=corecrow-smoke; prod_net=corecrow-api_default; dir=/root/smoke
runtime=/etc/blackpolar/corecrow.env; dataset_env=/etc/blackpolar/corecrow-dataset.env
umask 077; mkdir -p "$dir/state"; rm -f "$dir/state/state.json"

cleanup() {
  docker rm -f corecrow-smoke-api corecrow-smoke-worker corecrow-smoke-driver corecrow-smoke-pg >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT

docker network create "$net" >/dev/null
docker run -d --name corecrow-smoke-pg --network "$net" --memory 1g --pids-limit 256 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=corecrow_smoke_test postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec corecrow-smoke-pg pg_isready -U postgres -d corecrow_smoke_test >/dev/null 2>&1 && break; sleep 1; done

{
  grep -E '^(NORTH_ASSET_|NORTH_DATA_IMPORT_|CORECROW_CLAMAV_|AWS_|CORECROW_DOCKER_NETWORK)' "$runtime" | grep -v '^NORTH_DATA_IMPORT_WORKER_ENABLED='
  echo 'NORTH_DATA_IMPORT_WORKER_ENABLED=true'
  echo 'DATABASE_URL=postgresql://postgres@corecrow-smoke-pg:5432/corecrow_smoke_test'
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
  echo 'BETTER_AUTH_URL=http://corecrow-smoke-api:4000'
  echo 'TRUSTED_ORIGINS=http://smoke.test'
  echo 'SMTP_URL=smtp://corecrow-smoke-driver:5525?ignoreTLS=true'
  echo 'MAIL_FROM=smoke@smoke.test'
  echo 'NODE_ENV=development'  # production insists on an HTTPS BETTER_AUTH_URL; this stack is private and isolated
  echo 'PORT=4000'
  echo 'AI_ENABLED=false'
} > "$dir/smoke.env"
chmod 0600 "$dir/smoke.env"

docker run --rm --network "$net" --env-file "$dir/smoke.env" "$image" node node_modules/prisma/build/index.js migrate deploy 2>&1 | tail -1
docker run -d --name corecrow-smoke-api --network "$net" --env-file "$dir/smoke.env" --memory 1g --pids-limit 256 "$image" >/dev/null
docker run -d --name corecrow-smoke-worker --network "$net" --env-file "$dir/smoke.env" --memory 1536m --pids-limit 256 "$image" node dist/dataset-import-worker.js >/dev/null
docker network connect "$prod_net" corecrow-smoke-api
docker network connect "$prod_net" corecrow-smoke-worker
for _ in $(seq 1 40); do
  docker exec corecrow-smoke-api node -e "fetch('http://127.0.0.1:4000/v1/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && break; sleep 2
done

driver() { # driver <mode>
  docker rm -f corecrow-smoke-driver >/dev/null 2>&1 || true
  docker create --name corecrow-smoke-driver --network "$net" -v "$work:/work" -v "$fixtures:/fixtures:ro" -v "$dir/state:/state" \
    -w /work -e HOME=/tmp node:22-slim node scripts/smoke-xlsx-driver.mjs "$1" >/dev/null
  docker network connect "$prod_net" corecrow-smoke-driver
  docker start -a corecrow-smoke-driver
}
status=0
echo "=== phase 1: clean flow, authorization, hostile inputs, cancellation"
driver clean || status=1
echo "=== phase 2: worker stopped while an import is queued, then restarted"
docker stop corecrow-smoke-worker >/dev/null
driver enqueue || status=1
docker start corecrow-smoke-worker >/dev/null
driver await || status=1
echo "=== phase 3: ClamAV stopped (must block, never approve)"
docker stop corecrow-clamav >/dev/null
driver blocked || status=1
docker start corecrow-clamav >/dev/null
for _ in $(seq 1 60); do [[ "$(docker inspect -f '{{.State.Health.Status}}' corecrow-clamav)" == healthy ]] && break; sleep 5; done
echo "clamav after restart: $(docker inspect -f '{{.State.Health.Status}}' corecrow-clamav)"
echo "=== smoke exit status: $status"
exit "$status"
