FROM oven/bun:1.4.3-alpine AS bun-runtime

FROM postgres:18-alpine3.23

RUN apk add --no-cache aws-cli=2.32.7-r0 libstdc++
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock ./
COPY cli/package.json cli/package.json
COPY orchestrator/package.json orchestrator/package.json
COPY hub/package.json hub/package.json
COPY hub/deploy/site/package.json hub/deploy/site/package.json
COPY hub/data/package.json hub/data/package.json
COPY hub/site/package.json hub/site/package.json
COPY hub/ui/package.json hub/ui/package.json
COPY hub/util/package.json hub/util/package.json
COPY hub/views/package.json hub/views/package.json
COPY hub/web/package.json hub/web/package.json
COPY retrieval/package.json retrieval/package.json
RUN bun install --frozen-lockfile

COPY shared/record/migrations shared/record/migrations
COPY orchestrator/src/postgres/postgres-migrate.ts orchestrator/src/postgres/postgres-migrate.ts
COPY scripts/record-migration-set.ts scripts/record-migration-set.ts
COPY orchestrator/deploy/backup/rehearse.sh /usr/local/bin/rehearse.sh

ENTRYPOINT ["/usr/local/bin/rehearse.sh"]
