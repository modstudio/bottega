#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-review-boundary', 'orchestrator/src/schema-review.ts', [
  './review-vocabulary.ts',
  './schema-core.ts',
  './score.ts',
])
