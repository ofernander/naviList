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

# Copy compiled node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY . .

RUN addgroup -S navilist && adduser -S navilist -G navilist && \
    chown -R navilist:navilist /app

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
