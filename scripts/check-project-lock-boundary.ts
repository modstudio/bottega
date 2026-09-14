#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-project-lock-boundary',
  'orchestrator/src/project-lock.ts',
  ["./db.ts","./process-liveness.ts","./git-environment.ts","../../shared/git.ts"],
)
