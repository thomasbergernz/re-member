FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
# Copy the lockfile and use `npm ci` for reproducible, lockfile-pinned installs
# (npm install would re-resolve ^ ranges and could pull untested versions).
COPY package.json package-lock.json ./
RUN npm ci

# Build
FROM deps AS build
COPY . .
RUN npm run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 4321
ENV PORT=4321
ENV HOST=0.0.0.0

CMD ["node", "dist/server/entry.mjs"]
