FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY orchestrator/package.json orchestrator/package.json
COPY hub/package.json hub/package.json
COPY hub/web/package.json hub/web/package.json
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 3000
CMD ["bun", "orchestrator/src/record/record-api-server.ts"]
