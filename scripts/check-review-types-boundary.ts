#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-types-boundary', 'orchestrator/src/review-types.ts', [
  './review-vocabulary.ts',
  './change-identity.ts',
])
