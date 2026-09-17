FROM postgres:18-alpine3.23

RUN apk add --no-cache aws-cli=2.32.7-r0

COPY orchestrator/deploy/backup/backup.sh /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
