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

# NO instance configuration reaches this build, on purpose. The relay and SFU
# addresses used to arrive as VITE_* build args and were inlined into the
# bundle by vite, which made every instance's JavaScript different even when it
# built identical source - so a published hash of a release matched no running
# instance, and nobody could check that an instance serves what it claims to.
# They are written to /config.json at container start instead
# (docker-entrypoint.d/40-awful-config.sh) and read before the app mounts.
#
# Comma/space separated plugin sources (github urls, user/repo[#ref]) fetched
# into plugins/ before the build - see plugins/README.md. Empty = built-ins only.
ARG PLUGIN_SOURCES
# Set to 1 to let an unpinned source (no #ref) through fetch-plugins.
ARG PLUGIN_SOURCES_ALLOW_UNPINNED

# Escape hatch, and nothing sets it: neither compose nor CI passes this any
# more, because the build resolves the commit from .git below and a path
# nobody exercises is how every production image came to ship an empty commit
# in the first place. It stays for the one case .git cannot cover - building
# from a downloaded release archive, which has no repository in it.
ARG APP_COMMIT

ENV PLUGIN_SOURCES=$PLUGIN_SOURCES
ENV PLUGIN_SOURCES_ALLOW_UNPINNED=$PLUGIN_SOURCES_ALLOW_UNPINNED
ENV APP_COMMIT=$APP_COMMIT

RUN node scripts/fetch-plugins.mjs

# The commit, resolved from the repository rather than remembered by a human.
#
# Pre-1.0 there is no version to speak of - package.json is 0.0.0 on purpose -
# so the commit is the only identity a build has, and for a long time every
# production image shipped without one: the old build context was ./frontend
# while .git sits at the repo root, and node:alpine has no git binary anyway.
# That left APP_COMMIT as something whoever deployed had to remember, and
# dokploy has no built-in variable to fill it in with.
#
# So the refs come in and scripts/git-commit.mjs reads them directly - HEAD,
# then refs/ or packed-refs, about twenty lines and no git binary. WORKDIR is
# /app and holds the frontend, so /.git is the repo root's .git exactly as
# ../.git is in a checkout: one code path, both places. APP_COMMIT still wins
# when it is set, which is what CI does.
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
