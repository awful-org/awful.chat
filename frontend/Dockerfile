# Pinned minor: a floating :22-alpine changes what runs on every build with
# no diff to review.
FROM node:22.23-alpine AS base
# pinned major: pnpm 11 changed ignored-build-script handling to a hard error
RUN npm install -g pnpm@10
WORKDIR /app

# The build context is the REPO ROOT, not ./frontend - hence the frontend/
# prefixes below. It is the root so that .git is reachable; see the commit
# section further down. .dockerignore at the root trims the rest back out.
FROM base AS deps
# pnpm-workspace.yaml carries the build-script approvals - without it pnpm
# refuses to run postinstall scripts and the install fails
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .

# No instance configuration reaches this build, on purpose: vite would inline
# it, and every instance would then ship different JavaScript from identical
# source, which no published build hash could describe. The relay and SFU
# addresses are written to /config.json at container start instead
# (docker-entrypoint.d/40-awful-config.sh) and read before the app mounts.
#
# Comma/space separated plugin sources (github urls, user/repo[@ref]) fetched
# into plugins/ before the build - see plugins/README.md. Empty = built-ins only.
ARG PLUGIN_SOURCES
# Set to 1 to let an unpinned source (no #ref) through fetch-plugins.
ARG PLUGIN_SOURCES_ALLOW_UNPINNED

ENV PLUGIN_SOURCES=$PLUGIN_SOURCES
ENV PLUGIN_SOURCES_ALLOW_UNPINNED=$PLUGIN_SOURCES_ALLOW_UNPINNED

RUN node scripts/fetch-plugins.mjs

# The repository and commit this image is built from, which pre-1.0 is the
# only identity it has - package.json is 0.0.0 on purpose. node:alpine ships
# no git binary, so scripts/git-commit.mjs reads the refs directly. WORKDIR is
# /app and holds the frontend, so /.git is the repo root's .git exactly as
# ../.git is in a checkout: one code path, both places.
#
# Late on purpose: .git changes with every commit, and copying it earlier
# would invalidate the plugin fetch above on every single build.
COPY .git /.git

RUN pnpm build

# Pinned minor: a floating :alpine changes what runs on every build with no
# diff to review.
FROM nginx:1.30-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
# frontend/ prefixes here too: the context is the repo root (see the top of
# this file). Only the --from=builder copy above is relative to the image.
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
# nginx runs everything here before it starts, which is where /config.json
# gets written from the container's environment.
COPY frontend/docker-entrypoint.d/ /docker-entrypoint.d/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
