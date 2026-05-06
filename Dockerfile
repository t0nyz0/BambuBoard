FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

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
