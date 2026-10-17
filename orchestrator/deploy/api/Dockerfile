FROM oven/bun:1.4.2-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY cli/package.json cli/package.json
COPY orchestrator/package.json orchestrator/package.json
COPY hub/package.json hub/package.json
COPY hub/deploy/site/package.json hub/deploy/site/package.json
COPY hub/data/package.json hub/data/package.json
COPY hub/ui/package.json hub/ui/package.json
COPY hub/web/package.json hub/web/package.json
COPY retrieval/package.json retrieval/package.json
RUN bun install --frozen-lockfile

COPY . .

ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000
CMD ["bun", "orchestrator/src/record/record-api-server.ts"]
