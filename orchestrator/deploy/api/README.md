# Record API deployment

Run these commands from the repository root. Create the app directly; do not use `fly launch --no-deploy`.

```sh
fly apps create bottega-api --org bottega
fly secrets set -a bottega-api \
  ORCH_RECORD_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  BETTER_AUTH_SECRET='<generated-secret>' \
  BETTER_AUTH_URL='https://api.bottega.run'
fly deploy --config orchestrator/deploy/api/fly.toml
fly ips allocate-v4 --shared -a bottega-api
fly ips allocate-v6 -a bottega-api
fly certs add api.bottega.run -a bottega-api
```

At the DNS provider, create an `A` record for `api.bottega.run` with the shared IPv4 address printed by `fly ips allocate-v4`, and an `AAAA` record with the IPv6 address printed by `fly ips allocate-v6`. Check certificate and DNS validation with `fly certs check api.bottega.run -a bottega-api`.

Verify the public surface after the certificate is ready:

```sh
curl --fail-with-body https://api.bottega.run/health
curl --fail-with-body \
  -H 'Authorization: Bearer <token>' \
  https://api.bottega.run/v1/whoami
```
