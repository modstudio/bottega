FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY orchestrator/package.json orchestrator/package.json
COPY hub/package.json hub/package.json
COPY hub/deploy/site/package.json hub/deploy/site/package.json
COPY hub/web/package.json hub/web/package.json
COPY retrieval/package.json retrieval/package.json
RUN bun install --frozen-lockfile

COPY . .

ARG VITE_HUB_MODE=hosted
ARG VITE_RECORD_API_URL
ARG VITE_PUBLIC_SITE_ORIGIN
ARG VITE_APP_ORIGIN
ENV VITE_HUB_MODE=$VITE_HUB_MODE
ENV VITE_RECORD_API_URL=$VITE_RECORD_API_URL
ENV VITE_PUBLIC_SITE_ORIGIN=$VITE_PUBLIC_SITE_ORIGIN
ENV VITE_APP_ORIGIN=$VITE_APP_ORIGIN
# The flag belongs to `run`; `bun --cwd … run` prints usage and still exits 0,
# so the build asserts the bundle exists.
RUN bun run --cwd hub/web build && test -f hub/web/dist/index.html

EXPOSE 3000
CMD ["bun", "hub/src/hosted.ts"]
