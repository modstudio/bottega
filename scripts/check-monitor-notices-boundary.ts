#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-monitor-notices-boundary', 'orchestrator/src/monitor-notices.ts', [
  './db.ts',
  './monitor-conditions.ts',
  './monitor-types.ts',
  './review-vocabulary.ts',
])
