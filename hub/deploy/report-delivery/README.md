# Hosted report delivery

This hourly scheduled Machine prunes hosted change-log entries older than thirty days and
runs the same report-delivery pass as a person running `bun run --cwd hub report-deliver`.
Report delivery discovers only subscription scheduling metadata across spaces; every
subscription, membership, measure, and send-ledger read or write is performed with that
space bound under record row-level security. Pruning runs through the guarded record
function across spaces.

Run commands from the repository root. Create the app and install secrets without enabling
delivery:

```sh
fly apps create bottega-hub-report-delivery --org bottega
fly secrets set -a bottega-hub-report-delivery \
  HUB_RECORD_DATABASE_URL='postgres://record_actor:<password>@bottega-record.flycast:5432/record' \
  HUB_HOSTED_URL='https://app.bottega.run' \
  SES_REGION='us-east-2' \
  SES_FROM_ADDRESS='<display name and verified sender address>' \
  SES_ACCESS_KEY_ID='<access-key-id>' \
  SES_SECRET_ACCESS_KEY='<secret-access-key>'
```

Keep every value above as a Fly secret. The image defaults to report delivery being disabled
even when enabled subscriptions exist: without `HUB_REPORT_DELIVERY_ENABLED=true`, a
scheduled pass still prunes the change log, then exits successfully without reading
subscriptions or sending mail.

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

Before enabling, run a dry pass from a one-off Machine and inspect its output. Dry-run skips
change-log pruning, renders the recipients, subject, exact local window, and text body, writes
no send row, and uses no SES client:

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

## Updating

Build and push a new image, then update the scheduled Machine in place:

```sh
docker build --file hub/deploy/report-delivery/Dockerfile --tag <new image> .
docker push <new image>
fly machine update <scheduled machine id> \
  --image <new image> \
  -a bottega-hub-report-delivery
```

The in-place update keeps the hourly schedule and applies staged secrets. Never use
`fly deploy` for this app: it creates new unscheduled Machines and applies every staged
secret.
