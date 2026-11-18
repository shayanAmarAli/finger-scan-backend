# Production image (Railway builds this; CI builds and smoke-tests it).
# Secrets are NOT baked in: they come from the platform's environment.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Run as the unprivileged "node" user, never root.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
