#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-worktree-preflight-boundary',
  'orchestrator/src/worktree-preflight.ts',
  ["./projects.ts","./worktree-template.ts","./git-environment.ts"],
)

