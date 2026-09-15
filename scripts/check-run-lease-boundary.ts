#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-run-lease-boundary', 'orchestrator/src/run-lease.ts', [
  './database-location.ts',
  './project-lock.ts',
  './run-alive.ts',
])
