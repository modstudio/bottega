#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-run-types-boundary', 'orchestrator/src/run-types.ts', [
  './contract.ts',
  './worktree-remove.ts',
  './worktree-types.ts',
])
