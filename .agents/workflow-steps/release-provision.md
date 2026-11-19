---
title: Provision the release probe
stage: implement
floor:
  - recorded-artifact
jobs: []
autonomy: auto
needs: []
---
Register the probe repository and create its smoke task before composing this workflow. Close this step with `--artifact task:{{key}}` after reading the task back from the registered project.
