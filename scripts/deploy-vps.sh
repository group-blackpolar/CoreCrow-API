#!/usr/bin/env bash
# VPS topology established during the v1 rollout. Secrets stay on the host.
set -euo pipefail
release="$(pwd -P)"
case "$release" in /var/www/releases/*) ;; *) echo 'Run inside a release directory'; exit 1;; esac
version="${1:?Release identifier required}"
[[ "$version" =~ ^[a-zA-Z0-9-]+$ ]] || exit 1
image="corecrow-api:$version"
runtime=/etc/blackpolar/corecrow.env
sudo -n test -f "$runtime"
sudo -n docker build -t "$image" .
backup="/var/backups/blackpolar/corecrow-$version.dump"
sudo -n sh -c 'umask 077; docker exec corecrow-db pg_dump -U blackpolar -d blackpolar -Fc > "$1"' sh "$backup"
sudo -n docker run --rm --network corecrow-api_default --env-file "$runtime" "$image" node node_modules/prisma/build/index.js migrate deploy
candidate="corecrow-check-$version"
worker_candidate="corecrow-dataset-worker-check-$version"
sudo -n docker run -d --name "$candidate" --network corecrow-api_default --env-file "$runtime" -e CONTACT_NOTIFICATIONS_ENABLED=false -p 127.0.0.1:4101:4000 "$image" >/dev/null
trap 'sudo -n docker rm -f "$candidate" "$worker_candidate" >/dev/null 2>&1 || true' EXIT
ready=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4101/v1/live >/dev/null; then ready=true; break; fi
  sleep 2
done
"$ready" || { echo 'Candidate failed liveness; current API remains running'; exit 1; }
curl --silent --max-time 10 http://127.0.0.1:4101/v1/health | python3 -c 'import sys,json; s=json.load(sys.stdin); assert all(m["status"]=="available" for m in s["modules"])'
sudo -n docker run -d --name "$worker_candidate" --network corecrow-api_default --env-file "$runtime" "$image" node dist/dataset-import-worker.js >/dev/null
worker_ready=false
for attempt in {1..10}; do
  if [[ "$(sudo -n docker inspect -f '{{.State.Running}}' "$worker_candidate" 2>/dev/null || true)" == "true" ]]; then
    worker_ready=true
    sleep 2
    [[ "$(sudo -n docker inspect -f '{{.State.Running}}' "$worker_candidate" 2>/dev/null || true)" == "true" ]] && break
    worker_ready=false
  fi
  sleep 2
done
"$worker_ready" || { sudo -n docker logs "$worker_candidate" >&2 || true; echo 'Candidate dataset worker failed; current release remains running'; exit 1; }
previous="corecrow-rollback-$version"
worker_previous="corecrow-dataset-worker-rollback-$version"
had_previous=false
had_worker_previous=false
if sudo -n docker container inspect corecrow-v1 >/dev/null 2>&1; then
  had_previous=true
  sudo -n docker stop corecrow-v1 >/dev/null
  sudo -n docker rename corecrow-v1 "$previous"
fi
if sudo -n docker run -d --name corecrow-v1 --restart unless-stopped --network corecrow-api_default --env-file "$runtime" -p 127.0.0.1:4100:4000 "$image" >/dev/null; then
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:4100/v1/live >/dev/null; then
      if sudo -n docker container inspect corecrow-dataset-worker >/dev/null 2>&1; then
        had_worker_previous=true
        sudo -n docker stop corecrow-dataset-worker >/dev/null
        sudo -n docker rename corecrow-dataset-worker "$worker_previous"
      fi
      sudo -n docker update --restart unless-stopped "$worker_candidate" >/dev/null
      if sudo -n docker rename "$worker_candidate" corecrow-dataset-worker; then
        echo "CoreCrow $version and dataset worker running; previous containers and database backup retained"
        exit 0
      fi
      if "$had_worker_previous"; then
        sudo -n docker rename "$worker_previous" corecrow-dataset-worker
        sudo -n docker start corecrow-dataset-worker >/dev/null
      fi
      break
    fi
    sleep 2
  done
fi
sudo -n docker rm -f corecrow-v1 >/dev/null 2>&1 || true
if "$had_previous"; then
  sudo -n docker rename "$previous" corecrow-v1
  sudo -n docker start corecrow-v1 >/dev/null
fi
echo 'Release failed; previous API restored where available'
exit 1
