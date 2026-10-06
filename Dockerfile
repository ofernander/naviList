# ── Build stage: compile native modules ───────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# ── Runtime stage: lean image, no build tools ─────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

RUN addgroup -S navilist && adduser -S navilist -G navilist

# App files stay root-owned and read-only to the app user — it only writes to
# /app/data, which docker-entrypoint.sh creates and chowns at startup. (A
# chown -R of /app here re-copied all of node_modules on every source change.)
COPY --from=builder /app/node_modules ./node_modules
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
