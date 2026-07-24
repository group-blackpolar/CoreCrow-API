# syntax=docker/dockerfile:1

############################
# Base
############################
FROM node:20-slim AS base

RUN apt-get update && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

############################
# Dependencies
############################
FROM base AS deps

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

############################
# Build
############################
FROM deps AS build

COPY . .

# Genera el cliente de Prisma
RUN pnpm prisma generate

# Compila TypeScript
RUN pnpm build

# Elimina devDependencies
RUN pnpm prune --prod

############################
# Runtime
############################
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src/public ./dist/public

COPY package.json ./

EXPOSE 4000

CMD ["node", "dist/server.js"]