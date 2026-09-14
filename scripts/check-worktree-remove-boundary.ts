#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-worktree-remove-boundary',
  'orchestrator/src/worktree-remove.ts',
  ["./db.ts","./projects.ts","./recipe.ts","./worktree-attribution.ts","./git-environment.ts","./ref-guard.ts","./worktree-tool.ts","./worktree-types.ts"],
)

