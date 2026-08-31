# Next.js standalone — Node 24 (matches App Service / GitHub Actions)
FROM node:24-alpine AS base

FROM base AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/gun-preload.cjs ./gun-preload.cjs

RUN mkdir -p /app/data && chown nextjs:nodejs /app/data
ENV GUN_FILE=/app/data/radata
ENV GUN_SNAPSHOT=/app/data/snapshot.json

USER nextjs
EXPOSE 8080
CMD ["node", "-r", "./gun-preload.cjs", "server.js"]
