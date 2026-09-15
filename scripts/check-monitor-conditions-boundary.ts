#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-monitor-conditions-boundary', 'orchestrator/src/monitor-conditions.ts', [
  'node:fs',
  'node:path',
  './db.ts',
  './events.ts',
  './evidence-query.ts',
  './git-environment.ts',
  './idle-kill.ts',
  './monitor-types.ts',
  './process-liveness.ts',
  './project-lock.ts',
  './projects.ts',
  './resource-claims.ts',
  './resource-inventory.ts',
])
