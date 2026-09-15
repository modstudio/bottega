#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-worktree-remove-boundary', 'orchestrator/src/worktree-remove.ts', [
  './db.ts',
  './projects.ts',
  './recipe.ts',
  './tracked-recipe.ts',
  './worktree-attribution.ts',
  './git-environment.ts',
  './ref-guard.ts',
  './resource-claims.ts',
  './worktree-tool.ts',
  './worktree-types.ts',
])
