# syntax=docker/dockerfile:1
#
# Multi-stage build for @astroapp/compute.
#
# IMPORTANT: build with the MONOREPO ROOT as the build context, because the
# service depends on the workspace package @astroapp/shared:
#
#   docker build -f services/compute/Dockerfile -t astroapp-compute .
#
# Stage 1 (builder) installs the full workspace, builds @astroapp/shared and
# then @astroapp/compute. Stage 2 (runtime) is a slim node:24 image with only
# the production dependencies. The native `sweph` binding needs a C/C++
# toolchain + python at install time, so the builder image installs them.

# ---------- Stage 1: build ----------
FROM node:24-slim AS builder
WORKDIR /repo

# Native build deps for `sweph` (node-gyp): python3, make, g++.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Enable pnpm via corepack (pin to the repo's version).
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate

# Copy workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/compute/package.json services/compute/package.json

# Install ALL workspace deps (dev included — we need tsc + native build).
RUN pnpm install --frozen-lockfile

# Copy sources and build shared first, then compute.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/compute services/compute
RUN pnpm --filter @astroapp/shared build \
  && pnpm --filter @astroapp/compute build

# Prune to production dependencies for the runtime image.
RUN pnpm --filter @astroapp/compute --prod deploy /app

# ---------- Stage 2: runtime ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The deployed bundle includes node_modules (with the compiled sweph .node) and
# the built dist/.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /repo/services/compute/dist ./dist
COPY --from=builder /repo/services/compute/package.json ./package.json

# Swiss Ephemeris `.se1` data files, if present.
#
# The `eph[e]` bracket is a glob deliberately: a plain `COPY services/compute/ephe`
# FAILS the build when the directory doesn't exist, whereas a glob that matches
# nothing is a no-op. So one Dockerfile serves both cases — files present (Swiss
# backend, arc-second precision, Chiron + the four asteroids) and files absent
# (built-in Moshier, those bodies reported in `unavailableBodies`).
#
# `SWEPH_PATH` is set unconditionally because `initEphemeris()` checks the
# directory with `existsSync` and falls back to Moshier on its own — so pointing
# at a path that isn't there is safe, not a crash.
#
# NOTE: shipping `.se1` files engages Swiss Ephemeris licensing. This service is
# AGPL-3.0 and publishes its source to satisfy that — see README "License".
COPY services/compute/eph[e] /app/ephe
ENV SWEPH_PATH=/app/ephe

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
