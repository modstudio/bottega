#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-run-close-boundary', 'orchestrator/src/run-close.ts', [
  './close-out.ts',
  './contract.ts',
  './db.ts',
  './failover.ts',
  './failure.ts',
  './jobs.ts',
  './keep-tree-hold.ts',
  './mcp-preflight.ts',
  './projects.ts',
  './review-calibration.ts',
  './route.ts',
  './run-process.ts',
  './run-types.ts',
  './transport.ts',
  './worktree-remove.ts',
  './worktree-types.ts',
])
