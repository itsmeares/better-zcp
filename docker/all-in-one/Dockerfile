FROM node:22-bookworm-slim AS client-build

WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/package.json
COPY .husky/install.mjs ./.husky/install.mjs
RUN corepack install && pnpm install --filter pz-server-manager-client --frozen-lockfile
COPY client/ ./client/
# Same reasoning as the root Dockerfile: the frontend and the backend must be given the SAME
# build sha, or the build-compatibility gate compares "unknown" against a real sha and blocks
# the UI. No .git and no git binary exists in either stage.
ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}
RUN pnpm --filter pz-server-manager-client build

FROM cm2network/steamcmd:root

ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg lib32gcc-s1 lib32stdc++6 procps \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .husky/install.mjs ./.husky/install.mjs
RUN corepack enable && corepack install && pnpm install --filter pz-server-manager --prod --frozen-lockfile

COPY server/ ./server/
COPY --from=client-build /src/client/dist ./client/dist
COPY pz-mod/ ./pz-mod/
COPY docker/all-in-one/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /pz-server /zomboid /app/data /app/logs

ENV PZ_SERVER_PATH=/pz-server \
    PZ_SAVE_PATH=/zomboid \
    PZ_SERVER_BAT=start-server.sh \
    RCON_HOST=127.0.0.1 \
    RCON_PORT=27015

EXPOSE 3001 16261/udp 16262/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "import('http').then(h => h.get('http://localhost:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)))"

ENTRYPOINT ["/entrypoint.sh"]
