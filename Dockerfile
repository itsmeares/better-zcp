
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/panel-client/package.json ./apps/panel-client/package.json
COPY .husky/install.mjs ./.husky/install.mjs
RUN corepack install && pnpm install --filter @better-zcp/panel-client --frozen-lockfile

COPY package.json ./
COPY apps/panel-client/ ./apps/panel-client/

ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}
RUN pnpm --filter @better-zcp/panel-client build

FROM node:22-bookworm-slim

RUN set -eux; \
        apt-get update; \
        apt-get install -y --no-install-recommends bash ca-certificates curl procps tar util-linux wget; \
        if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
            apt-get install -y --no-install-recommends lib32gcc-s1 lib32stdc++6; \
        fi; \
        rm -rf /var/lib/apt/lists/*

ARG UID=1000
ARG GID=1000
RUN set -eux; \
    if getent group "$GID" >/dev/null 2>&1; then \
        groupname=$(getent group "$GID" | cut -d: -f1); \
    else \
        groupadd -g "$GID" panel; \
        groupname="panel"; \
    fi; \
    if getent passwd "$UID" >/dev/null 2>&1; then \
        :; \
    else \
        useradd -u "$UID" -g "$groupname" -M -s /usr/sbin/nologin panel; \
    fi

WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/panel-server/package.json ./apps/panel-server/package.json
COPY .husky/install.mjs ./.husky/install.mjs
RUN corepack enable && corepack install && pnpm install --filter @better-zcp/panel-server --prod --frozen-lockfile

COPY apps/panel-server/ ./apps/panel-server/

COPY --from=builder /app/apps/panel-client/dist ./apps/panel-client/dist

COPY integrations/panelbridge/ ./pz-mod/

COPY infra/docker/entrypoint.sh /usr/local/bin/zomboid-panel-entrypoint
RUN chmod 0755 /usr/local/bin/zomboid-panel-entrypoint

RUN mkdir -p data logs && chown -R ${UID}:${GID} /app

ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}

EXPOSE 3001

ENV PUID=1000 \
    PGID=1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "import('http').then(h => h.get('http://localhost:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)))"

ENTRYPOINT ["/usr/local/bin/zomboid-panel-entrypoint"]
CMD ["node", "apps/panel-server/index.js"]
