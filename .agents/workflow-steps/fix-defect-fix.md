---
title: Fix
stage: implement
floor:
  - recorded-artifact
jobs: [issue-worker]
autonomy: auto
needs: []
---
Write the fix specification to a file: the recorded diagnosis, the before-fix reproduction, the fix to make, and what must remain true. Dispatch `bottega run start issue-worker --key {{key}} --file <specification file>`.
