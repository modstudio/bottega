# Record API deployment

Run these commands from the repository root. Create the app directly; do not use `fly launch --no-deploy`.

```sh
fly apps create bottega-api --org bottega
fly secrets set -a bottega-api \
  ORCH_RECORD_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  RECORD_AUTH_DATABASE_URL='postgres://record_auth:<password>@bottega-record.flycast:5432/record' \
  BETTER_AUTH_SECRET='<generated-secret>' \
  BETTER_AUTH_URL='https://api.bottega.run' \
  RECORD_HUB_URL='https://app.bottega.run' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>'
scripts/deploy/hosted api
fly ips allocate-v4 --shared -a bottega-api
fly ips allocate-v6 -a bottega-api
fly certs add api.bottega.run -a bottega-api
```

The deploy script reads `ORCH_RECORD_MIGRATE_URL` from the environment, migrates the record,
and confirms that applied migrations equal those shipped in the image before invoking Fly. The
image's release command uses its low-privilege `ORCH_RECORD_URL` and refuses a release with
pending migrations, so a bare `fly deploy` cannot run ahead of the record schema.

Before migrating, create the dedicated Better Auth login and public-read role as the PostgreSQL
administrator. Granting the public role without inheritance lets the application actor switch to
it explicitly without applying its public policy to ordinary tenant queries:

```sql
CREATE ROLE record_auth LOGIN PASSWORD '<password>' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
```

The migration grants this role only the auth tables it needs and explicit access through RLS for
spaces, memberships, and invitations. Put its connection URL in the
`RECORD_AUTH_DATABASE_URL` Fly secret shown above. Application data continues to use
`record_actor` through `ORCH_RECORD_URL`.

After migrating, designate a public document project with the signed-in record user and the
migration-owner connection. The migrations ship no designation row. A space-only designation
does not exist; each designation names one project in its space:

```sh
orch record public-doc designate <public-space-slug> <public-project-name>
```

Use `orch record public-doc list` to inspect designations. Run
`orch record public-doc clear <public-space-slug> <public-project-name>` to remove one.

For browser clients, set `RECORD_API_ALLOWED_ORIGINS` to a comma-separated list of exact
origins. This enables credentialed CORS for those origins and also configures Better Auth's
trusted origins. When the browser and API use sibling subdomains, set
`RECORD_AUTH_COOKIE_DOMAIN` to their shared cookie domain; this enables secure cross-subdomain
session cookies. Leave both variables unset for the existing CLI-only behavior.

`RECORD_HUB_URL` is the hosted hub origin used for password-reset links. `SES_REGION`
selects the SES region, `SES_FROM_ADDRESS` supplies the verified From header, and the SES
access-key settings authenticate the SES v2 client. The secret values belong in Fly secrets,
not this file.

Record sign-up is invitation-only. A record space owner creates the required pending invitation
before the invitee signs up:

```sh
orch record space invite --email <email>
```

At the DNS provider, create an `A` record for `api.bottega.run` with the shared IPv4 address printed by `fly ips allocate-v4`, and an `AAAA` record with the IPv6 address printed by `fly ips allocate-v6`. Check certificate and DNS validation with `fly certs check api.bottega.run -a bottega-api`.

Verify the public surface after the certificate is ready:

```sh
curl --fail-with-body https://api.bottega.run/health
curl --fail-with-body \
  -H 'Authorization: Bearer <token>' \
  https://api.bottega.run/v1/whoami
```
