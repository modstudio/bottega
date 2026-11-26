---
description: Release branch, publication, installation, and runtime rules
paths:
  - orchestrator/src/commands/release.ts
  - orchestrator/src/commands/release-tree.ts
  - orchestrator/src/release/**
  - .github/workflows/release.yml
  - scripts/check-bun-versions.ts
  - scripts/check-release-rungs-live.ts
  - scripts/build-release-artifacts.ts
  - scripts/publish-release.ts
---

# Keep development on the landing branch when releasing

Keep Bottega's installed copy on `main`. Run `bottega release check`, then tag and push; never check out the tag there. The pushed tag reruns the check before publishing. `package.json` must match the tag. Because the per-user store migrates only forward, an older copy refuses it.

The tag publish refuses until each hosted rung is live for the tag; regenerate the tracked rungs file with `bottega release rungs --write`.

Elsewhere, install a release in its own directory and update it by replacing the directory.

Deploy images run `RELEASE_BUN_VERSION`; `scripts/check-bun-versions.ts` enforces it.
