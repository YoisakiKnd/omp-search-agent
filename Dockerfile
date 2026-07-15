FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM ghcr.io/typst/typst:0.15.0 AS typst

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
USER root
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=typst /bin/typst /usr/local/bin/typst
RUN typst --version
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["bun", "run", "healthcheck"]
CMD ["bun", "run", "start"]
