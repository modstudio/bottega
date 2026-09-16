FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY orchestrator/package.json orchestrator/package.json
COPY hub/package.json hub/package.json
COPY hub/web/package.json hub/web/package.json
RUN bun install --frozen-lockfile

COPY . .

ARG VITE_HUB_MODE=hosted
ARG VITE_RECORD_API_URL
ENV VITE_HUB_MODE=$VITE_HUB_MODE
ENV VITE_RECORD_API_URL=$VITE_RECORD_API_URL
RUN bun --cwd hub/web run build

EXPOSE 3000
CMD ["bun", "hub/src/hosted.ts"]
