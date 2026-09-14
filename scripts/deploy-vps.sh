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
sudo -n docker run -d --name "$candidate" --network corecrow-api_default --env-file "$runtime" -p 127.0.0.1:4101:4000 "$image" >/dev/null
trap 'sudo -n docker rm -f "$candidate" >/dev/null 2>&1 || true' EXIT
ready=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:4101/v1/live >/dev/null; then ready=true; break; fi
  sleep 2
done
"$ready" || { echo 'Candidate failed liveness; current API remains running'; exit 1; }
curl --silent --max-time 10 http://127.0.0.1:4101/v1/health | python3 -c 'import sys,json; s=json.load(sys.stdin); assert all(m["status"]=="available" for m in s["modules"])'
previous="corecrow-rollback-$version"
had_previous=false
if sudo -n docker container inspect corecrow-v1 >/dev/null 2>&1; then
  had_previous=true
  sudo -n docker stop corecrow-v1 >/dev/null
  sudo -n docker rename corecrow-v1 "$previous"
fi
if sudo -n docker run -d --name corecrow-v1 --restart unless-stopped --network corecrow-api_default --env-file "$runtime" -p 127.0.0.1:4100:4000 "$image" >/dev/null; then
  for attempt in {1..20}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:4100/v1/live >/dev/null; then
      echo "CoreCrow $version running on loopback 4100; previous container and database backup retained"
      exit 0
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
