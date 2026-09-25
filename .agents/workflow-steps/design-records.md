---
title: Update design records
stage: docs
floor:
  - recorded-artifact
job: null
autonomy: auto
needs:
  - docs
---
From the change just merged, name the high-level features, functions or plumbing it touches. For each, search the document store through the docs adapter named by `{{docs.protocol}}`, using its read actions listed in `facts`. Update the existing record for the feature when one exists. Otherwise, create one named `design-<feature>`, unless the store has its own naming convention for feature records, in which case follow that convention. Write each record through the adapter's write actions listed in `facts`. The `orch-docs` adapter writes through `orch doc set` so the lint applies. Each record states current behavior, the reasons for its design, build or buy, anything provisional with its exit criterion, and how it is measured. Record which records changed, or why none needed to.
