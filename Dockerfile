# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
ARG TARGETARCH=amd64
COPY package.json bun.lock ./
# OMP declares local speech/embedding runtimes as optional. This service only enables
# web_search, so remove those large model runtimes after retaining Sharp's glibc addon.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    set -eux; \
    case "$TARGETARCH" in \
      amd64) bun_cpu=x64 ;; \
      arm64) bun_cpu=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun install --frozen-lockfile --production --os=linux --cpu="$bun_cpu"; \
    rm -rf \
      node_modules/@huggingface \
      node_modules/onnxruntime-node \
      node_modules/onnxruntime-web \
      node_modules/sherpa-onnx-node \
      node_modules/sherpa-onnx-linux-* \
      node_modules/@img/*linuxmusl* \
      node_modules/lightningcss-linux-*-musl; \
    if [ "$TARGETARCH" = amd64 ]; then \
      rm -f node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64-modern.node; \
    fi; \
    find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM debian:bookworm-slim AS fonts
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk libstdc++6 \
    && mkdir -p /opt/fonts /opt/runtime/lib /opt/runtime/data /opt/runtime/home/bun/.omp/agent \
    && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc /opt/fonts/ \
    && cp /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc /opt/fonts/ \
    && cp -L "$(find /usr/lib -name libstdc++.so.6 -print -quit)" /opt/runtime/lib/ \
    && cp -L "$(find /lib /usr/lib -name libgcc_s.so.1 -print -quit)" /opt/runtime/lib/ \
    && chown -R 1000:1000 /opt/runtime \
    && rm -rf /var/lib/apt/lists/*

FROM ghcr.io/typst/typst:0.15.0 AS typst

FROM oven/bun:${BUN_VERSION}-distroless AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOME=/home/bun \
    XDG_CACHE_HOME=/tmp/.cache \
    LD_LIBRARY_PATH=/usr/local/lib \
    PI_NATIVE_VARIANT=baseline
COPY --from=typst /bin/typst /usr/local/bin/typst
COPY --from=fonts /opt/fonts/ /usr/share/fonts/opentype/noto/
COPY --from=fonts /opt/runtime/lib/ /usr/local/lib/
COPY --from=fonts --chown=1000:1000 /opt/runtime/data/ /data/
COPY --from=fonts --chown=1000:1000 /opt/runtime/home/bun/ /home/bun/
COPY --from=deps --chown=1000:1000 /app/node_modules/ ./node_modules/
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 src/ ./src/
USER 1000:1000
VOLUME ["/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["bun", "run", "src/healthcheck.ts"]
CMD ["run", "src/main.ts"]
