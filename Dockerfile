FROM node:22-alpine AS base
# Prisma's native engines require OpenSSL in build and runtime stages.
RUN apk add --no-cache openssl
WORKDIR /app
ENV TZ=UTC NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true npm ci

FROM deps AS builder
COPY prisma ./prisma
RUN npm run db:generate
COPY . .
RUN npm run build

FROM deps AS production-deps
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
USER app
ENTRYPOINT ["./docker-entrypoint.sh"]

FROM runtime AS worker
COPY --chown=app:app --from=production-deps /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=app:app --from=builder /app/src ./src
COPY --chown=app:app --from=builder /app/package.json /app/tsconfig.json ./
COPY --chown=app:app scripts/worker-health.mjs ./scripts/worker-health.mjs
CMD ["node", "--import", "tsx", "src/worker/main.ts"]

# Only the one-shot migrator retains the locked Prisma CLI/build tools.
FROM runtime AS migrate
COPY --chown=app:app --from=builder /app/node_modules ./node_modules
COPY --chown=app:app --from=builder /app/prisma ./prisma
COPY --chown=app:app --from=builder /app/src ./src
COPY --chown=app:app --from=builder /app/package.json /app/tsconfig.json ./
CMD ["migrate"]

# Default target: traced Next server plus its separately copied public assets.
FROM runtime AS web
ENV HOSTNAME=0.0.0.0 PORT=3000
COPY --chown=app:app --from=builder /app/.next/standalone ./
COPY --chown=app:app --from=builder /app/.next/static ./.next/static
COPY --chown=app:app --from=builder /app/public ./public
COPY --chown=app:app --from=builder /app/prisma/migrations ./prisma/migrations
COPY --chown=app:app --from=builder /app/node_modules/.prisma ./node_modules/.prisma
EXPOSE 3000
CMD ["node", "server.js"]
