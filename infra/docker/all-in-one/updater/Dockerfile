FROM docker:27-cli

RUN apk add --no-cache nodejs curl tar docker-cli-compose

WORKDIR /controller
COPY infra/docker/all-in-one/updater/server.mts ./server.mts
COPY infra/docker/all-in-one/updater/containerLifecycle.mts ./containerLifecycle.mts

EXPOSE 3100
ENTRYPOINT []
CMD ["node", "--experimental-strip-types", "server.mts"]
