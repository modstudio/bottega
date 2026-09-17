# Record API deployment

Run these commands from the repository root. Create the app directly; do not use `fly launch --no-deploy`.

```sh
fly apps create bottega-api --org bottega
fly secrets set -a bottega-api \
  ORCH_RECORD_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  BETTER_AUTH_SECRET='<generated-secret>' \
  BETTER_AUTH_URL='https://api.bottega.run' \
  RECORD_HUB_URL='https://app.bottega.run' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>'
fly deploy --config orchestrator/deploy/api/fly.toml
fly ips allocate-v4 --shared -a bottega-api
fly ips allocate-v6 -a bottega-api
fly certs add api.bottega.run -a bottega-api
```

For browser clients, set `RECORD_API_ALLOWED_ORIGINS` to a comma-separated list of exact
origins. This enables credentialed CORS for those origins and also configures Better Auth's
trusted origins. When the browser and API use sibling subdomains, set
`RECORD_AUTH_COOKIE_DOMAIN` to their shared cookie domain; this enables secure cross-subdomain
session cookies. Leave both variables unset for the existing CLI-only behavior.

`RECORD_HUB_URL` is the hosted hub origin used for password-reset links. `SES_REGION`
selects the SES region, `SES_FROM_ADDRESS` supplies the verified From header, and the SES
access-key settings authenticate the SES v2 client. The secret values belong in Fly secrets,
not this file.

At the DNS provider, create an `A` record for `api.bottega.run` with the shared IPv4 address printed by `fly ips allocate-v4`, and an `AAAA` record with the IPv6 address printed by `fly ips allocate-v6`. Check certificate and DNS validation with `fly certs check api.bottega.run -a bottega-api`.

Verify the public surface after the certificate is ready:

```sh
curl --fail-with-body https://api.bottega.run/health
curl --fail-with-body \
  -H 'Authorization: Bearer <token>' \
  https://api.bottega.run/v1/whoami
```
