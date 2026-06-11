# ── Stage 1: base ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base

# tini: proper PID-1 signal handling so Node.js exits cleanly on SIGTERM
RUN apk add --no-cache tini

WORKDIR /app

# ── Stage 2: deps ──────────────────────────────────────────────────────────────
FROM base AS deps

COPY package.json package-lock.json ./

# Install production deps only — no devDependencies
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Stage 3: production ────────────────────────────────────────────────────────
FROM base AS production

# Create non-root user for security
RUN addgroup -g 1001 -S agent && \
    adduser  -u 1001 -S agent -G agent

# Copy deps from stage 2
COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules

# Copy source
COPY --chown=agent:agent agent/     ./agent/
COPY --chown=agent:agent tools/     ./tools/
COPY --chown=agent:agent scripts/   ./scripts/
COPY --chown=agent:agent package.json ./

USER agent

EXPOSE 3000

# Health check — polls /health every 20s, allows 30s start-up
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# tini as PID 1 → node as child process
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "agent/webhook-server.js"]
