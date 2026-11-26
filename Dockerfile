# JP Interio API — container image for Google Cloud Run (DEC-307).
# No secrets in the image: every setting comes from Cloud Run's environment /
# Secret Manager at start-up (see README, "Deploying").

# ---- 1. Build: install everything, make the Prisma client, compile TypeScript ----
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# tsconfig must be here BEFORE `prisma generate`: Prisma reads it to write
# `./x.js` imports (what Node needs after tsc). Without it, it writes `./x.ts`
# and the compiled server can't start.
COPY tsconfig.json tsconfig.build.json ./
# `npm ci` runs `prisma generate` (postinstall) into src/generated/prisma.
RUN npm ci

COPY src ./src
RUN npm run build

# Keep only what the running server needs.
RUN npm prune --omit=dev

# ---- 2. Run: a small image with the compiled server only ----
FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Cloud Run sends traffic to $PORT (8080 by default); env.ts reads PORT.
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
