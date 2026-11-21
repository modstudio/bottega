---
title: Provision the release probe
stage: implement
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs: []
---
Register the probe repository and create its smoke task before composing this workflow. After reading the task back from the registered project, record a comment on it with `bottega task comment {{key}} "<note>"` saying the probe repository is registered, then close this step with `--artifact task:{{key}}`.
