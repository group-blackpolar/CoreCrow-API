# MinIO server and `mc`, built from the official source tags.
#
# MinIO stopped publishing community container images (quay.io/minio/minio has no manifests and Docker Hub denies
# pulls) and archived github.com/minio/minio. The last release notes tell container users to build from source, so this
# file does exactly that, pinning every input:
#   - source commits are verified after checkout (a moved or forged tag fails the build);
#   - the Go builder and the runtime base are official Docker library images pinned by digest.
# The result is a LOCAL image. Pin it in corecrow-dataset.env by image ID (MINIO_IMAGE=sha256:<id>) printed by
# scripts/build-minio-images.sh. MinIO community is no longer maintained: plan a migration (see ADR-023).
#
# Build:  scripts/build-minio-images.sh

ARG GO_IMAGE=golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

FROM ${GO_IMAGE} AS build
ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
RUN set -eux; \
    git clone --quiet https://github.com/minio/minio /src/minio; \
    git -C /src/minio checkout --quiet "${MINIO_TAG}"; \
    test "$(git -C /src/minio rev-parse HEAD)" = "${MINIO_COMMIT}"; \
    git clone --quiet https://github.com/minio/mc /src/mc; \
    git -C /src/mc checkout --quiet "${MC_TAG}"; \
    test "$(git -C /src/mc rev-parse HEAD)" = "${MC_COMMIT}"
RUN cd /src/minio && go build -tags kqueue -trimpath --ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio .
RUN cd /src/mc && go build -ldflags "-s -w" -o /out/mc .

FROM ${RUNTIME_IMAGE} AS runtime-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin minio \
 && mkdir /data && chown 10001:10001 /data

FROM runtime-base AS minio
COPY --from=build /out/minio /usr/bin/minio
USER 10001:10001
EXPOSE 9000 9001
ENTRYPOINT ["/usr/bin/minio"]

FROM runtime-base AS mc
COPY --from=build /out/mc /usr/bin/mc
ENV HOME=/tmp MC_CONFIG_DIR=/tmp/.mc
USER 10001:10001
ENTRYPOINT ["/usr/bin/mc"]
