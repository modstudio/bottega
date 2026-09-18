# Hosted report delivery

This hourly scheduled Machine runs the same report-delivery pass as a person running
`bun run --cwd hub report-deliver`. It discovers only subscription scheduling metadata
across spaces; every subscription, membership, measure, and send-ledger read or write is
performed with that space bound under record row-level security.

Run commands from the repository root. Create the app and install secrets without enabling
delivery:

```sh
fly apps create bottega-hub-report-delivery --org bottega
fly secrets set -a bottega-hub-report-delivery \
  HUB_RECORD_DATABASE_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>'
```

Keep every value above as a Fly secret. The image defaults to disabled even when enabled
subscriptions exist: without `HUB_REPORT_DELIVERY_ENABLED=true`, a scheduled pass exits
successfully without reading subscriptions or sending mail.

Build and create the disabled hourly Machine:

```sh
fly machine run . \
  --app bottega-hub-report-delivery \
  --config hub/deploy/report-delivery/fly.toml \
  --dockerfile hub/deploy/report-delivery/Dockerfile \
  --region ewr \
  --vm-size shared-cpu-1x \
  --schedule hourly
```

Before enabling, run a dry pass from a one-off Machine and inspect its output. Dry-run renders
the recipients, subject, exact local window, and text body, but writes no send row and uses no
SES client:

```sh
fly machine run . \
  --app bottega-hub-report-delivery \
  --config hub/deploy/report-delivery/fly.toml \
  --dockerfile hub/deploy/report-delivery/Dockerfile \
  --region ewr \
  --rm \
  -- --dry-run
```

Enable only after the dry output and enabled subscription list are approved:

```sh
fly secrets set -a bottega-hub-report-delivery HUB_REPORT_DELIVERY_ENABLED=true
```

To disable immediately, unset the flag and verify the next Machine log names the disabled
state:

```sh
fly secrets unset -a bottega-hub-report-delivery HUB_REPORT_DELIVERY_ENABLED
```
