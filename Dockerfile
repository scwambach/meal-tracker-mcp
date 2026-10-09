# Base images come from Google's Docker Hub mirror to avoid Docker Hub pull limits.

# Dependencies are pure JavaScript, so install them once on the build machine's own
# architecture and copy them into each target image (no emulation needed for arm64).
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM mirror.gcr.io/library/node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3030
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 3030
USER node
CMD ["node", "src/http.ts"]
