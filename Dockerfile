ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable pnpm
WORKDIR /app

FROM base AS build
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/client/package.json ./packages/client/
COPY packages/server/package.json ./packages/server/
COPY . .
RUN pnpm install --frozen-lockfile=false
RUN pnpm build

FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="DeckOS"
LABEL org.opencontainers.image.description="Self-hosted homelab management platform"
LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.vendor="DeckOS"

RUN apk add --no-cache docker-cli
ENV NODE_ENV=production
RUN corepack enable pnpm
WORKDIR /app

RUN addgroup -g 1001 -S deckos && \
    adduser -u 1001 -S deckos -G deckos && \
    mkdir -p /data

COPY --from=build /app/pnpm-lock.yaml ./
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/client/dist ./packages/client/dist

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --prefer-offline --ignore-scripts && \
    chown -R deckos:deckos /app /data

USER deckos
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "packages/server/dist/index.js"]