---
title: Close the release writing probe
stage: ship
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs: []
---
Close the release verification after provisioning, dispatch, and verification have completed. Read the smoke task back, record a closing comment on it with `bottega task comment {{key}} "<note>"`, then close this step with `--artifact task:{{key}}`.
