FROM docker:27-cli

RUN apk add --no-cache nodejs curl tar docker-cli-compose

WORKDIR /controller
COPY infra/docker/all-in-one/updater/server.js ./server.js
COPY infra/docker/all-in-one/updater/containerLifecycle.cjs ./containerLifecycle.cjs

EXPOSE 3100
ENTRYPOINT []
CMD ["node", "server.js"]
