#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-run-live-boundary',
  'orchestrator/src/run-live.ts',
  [
    './agents.ts', './ask.ts', './checkpoint.ts', './codex-mcp-scope.ts',
    './confinement.ts', './contract.ts', './db.ts', './events.ts', './failure.ts',
    './git-environment.ts', './idle-kill.ts', './jobs.ts', './mailbox.ts',
    './outcome.ts', './project-lock.ts', './run-process.ts', './sandbox.ts',
    './transport.ts', './worktree-types.ts',
  ],
)
