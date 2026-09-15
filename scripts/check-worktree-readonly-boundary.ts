#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-worktree-readonly-boundary', 'orchestrator/src/worktree-readonly.ts', [
  './projects.ts',
  './readonly-provision.ts',
  './worktree-template.ts',
  './git-environment.ts',
  './worktree-remove.ts',
  './worktree-create.ts',
  './worktree-types.ts',
])
