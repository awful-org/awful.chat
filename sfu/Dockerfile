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

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
