FROM node:22-alpine AS base
# pinned major: pnpm 11 changed ignored-build-script handling to a hard error
RUN npm install -g pnpm@10
WORKDIR /app

FROM base AS deps
# pnpm-workspace.yaml carries the build-script approvals - without it pnpm
# refuses to run postinstall scripts and the install fails
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG VITE_SIGNAL_URL
ARG VITE_API_URL
ARG VITE_RELAY_MULTIADDR
# One SFU, or a comma-separated list of them. With a list, each room is placed
# on one server by hashing its room code, so every participant agrees without
# coordinating - see src/lib/transport/sfu-pool.ts. Neither reached the build
# before, so setting VITE_SFU_URL in .env quietly did nothing.
ARG VITE_SFU_URL
ARG VITE_SFU_URLS
# Comma/space separated plugin sources (github urls, user/repo[#ref]) fetched
# into plugins/ before the build - see plugins/README.md. Empty = built-ins only.
ARG PLUGIN_SOURCES

ENV VITE_SIGNAL_URL=$VITE_SIGNAL_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_RELAY_MULTIADDR=$VITE_RELAY_MULTIADDR
ENV VITE_SFU_URL=$VITE_SFU_URL
ENV VITE_SFU_URLS=$VITE_SFU_URLS
ENV PLUGIN_SOURCES=$PLUGIN_SOURCES

RUN node scripts/fetch-plugins.mjs
RUN pnpm build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
