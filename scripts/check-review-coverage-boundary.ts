#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-coverage-boundary', 'orchestrator/src/review-coverage.ts', [
  './db.ts', './git-environment.ts', './change-identity.ts', './review-evidence-sql.ts',
  './review-pins.ts', './review-types.ts',
])
