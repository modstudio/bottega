# Hub viewer deployment

Run these commands from the repository root. Create the app directly; do not use `fly launch --no-deploy`.

The image is built from the repository root. `VITE_HUB_MODE`, `VITE_RECORD_API_URL`,
`VITE_PUBLIC_SITE_ORIGIN`, and `VITE_APP_ORIGIN` are build arguments baked into the web
bundle. `BOTTEGA_RECORD_API_URL` and `BOTTEGA_RECORD_DATABASE_URL` are runtime secrets the server
uses for the record API and its hosted report procedures. The SES secrets are present because Send test
(`sendReportSubscriptionTest`) mails from the web app.

```sh
fly apps create bottega-hub --org bottega
fly secrets set -a bottega-hub \
  BOTTEGA_RECORD_API_URL='https://api.bottega.run' \
  BOTTEGA_RECORD_DATABASE_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>'
bottega release run bottega --rung hosted-hub
fly ips allocate-v4 --shared -a bottega-hub
fly ips allocate-v6 -a bottega-hub
fly certs add app.bottega.run -a bottega-hub
fly certs add next.bottega.run -a bottega-hub
```

The app is deployed with `bottega release run bottega --rung hosted-hub`; the deploy script refuses a
direct call. The deploy script preserves the hosted web build arguments. It takes
`BOTTEGA_RECORD_MIGRATE_URL` from the environment, or reads that one variable from the operator's
env file when the environment lacks it, and gives the value to the migration only, never to
Fly. It then migrates the record and confirms that applied migrations equal those shipped in
the image before invoking Fly. The image's release command
uses its low-privilege `BOTTEGA_RECORD_DATABASE_URL` and refuses a release with pending migrations,
so a bare `fly deploy` cannot run ahead of the record schema.
The app serves `GET /version` with the commit it was built from; the deploy script supplies that
commit as a build argument.

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
