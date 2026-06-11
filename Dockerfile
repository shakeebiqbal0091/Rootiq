FROM node:22-alpine AS base

RUN apk add --no-cache tini

WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS production

RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent

COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules

COPY --chown=agent:agent agent/ ./agent/
COPY --chown=agent:agent tools/ ./tools/
COPY --chown=agent:agent scripts/ ./scripts/
COPY --chown=agent:agent package.json ./

USER agent

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "agent/webhook-server.js"]