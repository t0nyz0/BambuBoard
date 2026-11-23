FROM node:24-alpine3.24 AS system-packages

# CI refreshes this stage against the current Alpine package repositories.
# SwiftShader supplies WebGL on NAS/server hosts without a usable GPU.
RUN apk upgrade --no-cache \
    && apk add --no-cache ffmpeg chromium chromium-swiftshader ca-certificates 'glib>=2.88.4-r0'

FROM system-packages

WORKDIR /usr/src/app

ENV FFMPEG_BIN=/usr/bin/ffmpeg
ENV BAMBUBOARD_CHROMIUM_BIN=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
       /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The running app needs Node and FFmpeg, not package-manager tools. Removing
# those build tools also excludes their unused dependency trees from runtime.

COPY . .

RUN install -d -o node -g node -m 0750 /usr/src/app/data

# Keep the container port stable. Display settings come from the saved config.
ENV BAMBUBOARD_CONTAINER=1 \
    BAMBUBOARD_HTTP_PORT=8080

EXPOSE 8080

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "scripts/docker-healthcheck.js"]

ENTRYPOINT ["sh", "/usr/src/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
