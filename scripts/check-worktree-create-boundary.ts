#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-worktree-create-boundary',
  'orchestrator/src/worktree-create.ts',
  ["./db.ts","./projects.ts","./recipe.ts","./worktree-template.ts","./worktree-attribution.ts","./git-environment.ts","./project-lock.ts","./worktree-remove.ts","./worktree-caller.ts","./worktree-tool.ts","./worktree-types.ts"],
)

