#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-triage-boundary', 'orchestrator/src/review-triage.ts', [
  './db.ts',
  './review-vocabulary.ts',
  './contract.ts',
  './review.ts',
])
