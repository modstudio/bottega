#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'
checkModuleBoundary(
  'check-review-coverage-match-boundary',
  'orchestrator/src/review-coverage-match.ts',
  [],
)
