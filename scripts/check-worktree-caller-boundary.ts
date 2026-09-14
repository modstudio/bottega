#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-worktree-caller-boundary',
  'orchestrator/src/worktree-caller.ts',
  ["./projects.ts","./git-environment.ts","./worktree-types.ts"],
)

