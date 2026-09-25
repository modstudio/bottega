# Hub viewer deployment

Run these commands from the repository root. Create the app directly; do not use `fly launch --no-deploy`.

The image is built from the repository root. `VITE_HUB_MODE` and `VITE_RECORD_API_URL` are
build arguments baked into the web bundle. `HUB_RECORD_API_URL` and
`HUB_RECORD_DATABASE_URL` are runtime secrets the server uses for the record API and its
hosted report procedures. The SES secrets are present because Send test
(`sendReportSubscriptionTest`) mails from the web app.

```sh
fly apps create bottega-hub --org bottega
fly secrets set -a bottega-hub \
  HUB_RECORD_API_URL='https://api.bottega.run' \
  HUB_RECORD_DATABASE_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>'
fly deploy --config hub/deploy/fly.toml \
  --build-arg VITE_HUB_MODE=hosted \
  --build-arg VITE_RECORD_API_URL='https://api.bottega.run'
fly ips allocate-v4 --shared -a bottega-hub
fly ips allocate-v6 -a bottega-hub
fly certs add app.bottega.run -a bottega-hub
fly certs add next.bottega.run -a bottega-hub
```

On the record API app, allow the hub origin and share the parent cookie domain:

```sh
fly secrets set -a bottega-api \
  RECORD_API_ALLOWED_ORIGINS='https://app.bottega.run,https://next.bottega.run' \
  RECORD_AUTH_COOKIE_DOMAIN='.bottega.run'
```

At the DNS provider, create an `A` record for `app.bottega.run` with the shared IPv4 address printed by `fly ips allocate-v4`, and an `AAAA` record with the IPv6 address printed by `fly ips allocate-v6`. Check certificate and DNS validation with `fly certs check app.bottega.run -a bottega-hub`.

If Access is enabled on this hostname, allow the same origin that signs in through the record API, and do not strip the session `Cookie` header on `/trpc` or static assets.

Verify the public surface after the certificate is ready:

```sh
curl --fail-with-body https://app.bottega.run/health
```
