#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-run-terminal-boundary', 'orchestrator/src/run-terminal.ts', [
  './ask.ts',
  './checkpoint.ts',
  './confinement.ts',
  './contract.ts',
  './db.ts',
  './evidence.ts',
  './failure.ts',
  './idle-kill.ts',
  './jobs.ts',
  './mcp-preflight.ts',
  './outcome.ts',
  './projects.ts',
  './resource-ownership.ts',
  './review.ts',
  './run-artifacts.ts',
  './run-liveness.ts',
  './run-process.ts',
  './sandbox.ts',
  './worktree-remove.ts',
  './worktree-types.ts',
])
