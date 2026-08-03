FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# The web container and the worker container run the same image with different
# commands, so the runtime keeps the full dependency tree: the worker executes
# TypeScript through tsx.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/tsconfig.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
