#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-monitor-boundary', 'orchestrator/src/monitor.ts', [
  'node:fs',
  'node:path',
  '../../shared/brand.ts',
  './canon.ts',
  './db.ts',
  './docker-resources.ts',
  './git-locks.ts',
  './mcp.ts',
  './monitor-conditions.ts',
  './monitor-notices.ts',
  './monitor-types.ts',
  './process-liveness.ts',
  './project-lock.ts',
  './projects.ts',
  './reclaim.ts',
  './grok-trust.ts',
  './resource-ownership.ts',
  './review-vocabulary.ts',
  './run-artifacts.ts',
  './worktree-attribution.ts',
])
