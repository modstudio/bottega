#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-monitor-types-boundary', 'orchestrator/src/monitor-types.ts', [
  './review-vocabulary.ts',
])
