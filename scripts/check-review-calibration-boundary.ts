#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-calibration-boundary', 'orchestrator/src/review-calibration.ts', [
  './db.ts', './review-vocabulary.ts', './statistics.ts', './review-evidence-sql.ts',
  './review-triage.ts',
])
