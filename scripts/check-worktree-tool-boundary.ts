#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-worktree-tool-boundary',
  'orchestrator/src/worktree-tool.ts',
  ["./worktree-template.ts","./git-environment.ts"],
)

