FROM node:24-alpine3.24

WORKDIR /usr/src/app

# Use Alpine's maintained FFmpeg instead of the older static download.
# ffmpeg-static and rtsp-relay both honor this path, including during install.
RUN apk upgrade --no-cache && apk add --no-cache ffmpeg chromium ca-certificates
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

# Default config envs (override via docker-compose / docker run -e)
ENV BAMBUBOARD_HTTP_PORT=8080 \
    BAMBUBOARD_TEMP_SETTING=Both \
    BAMBUBOARD_FAN_PERCENTAGES=false \
    BAMBUBOARD_FAN_ICONS=true \
    BAMBUBOARD_PRINTER_TYPE=X1 \
    BAMBUBOARD_LOGGING=false

EXPOSE 8080

CMD ["node", "src/server.js"]
