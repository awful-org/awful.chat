FROM node:22-alpine AS base
RUN npm install -g pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG VITE_SIGNAL_URL
ARG VITE_API_URL
ARG VITE_RELAY_MULTIADDR

ENV VITE_SIGNAL_URL=$VITE_SIGNAL_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_RELAY_MULTIADDR=$VITE_RELAY_MULTIADDR

RUN pnpm build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
