FROM node:22-slim AS base
WORKDIR /app

# mediasoup native build deps (needed if prebuilt binary is unavailable)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip make g++ \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

# Create non-root user to avoid running node and mediasoup native worker as
# root. The RTC port range (61000-61499 by default) is above 1024 so a non-root
# user can bind it.
RUN useradd --create-home --no-log-init sfu && chown -R sfu:sfu /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 3000

ENV NODE_ENV=production

USER sfu

CMD ["node", "dist/index.js"]
