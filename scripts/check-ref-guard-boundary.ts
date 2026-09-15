#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-ref-guard-boundary', 'orchestrator/src/ref-guard.ts', [
  './db.ts',
  './process-liveness.ts',
  './worktree-attribution.ts',
  './git-environment.ts',
])
