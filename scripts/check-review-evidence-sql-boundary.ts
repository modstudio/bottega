#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-evidence-sql-boundary', 'orchestrator/src/review-evidence-sql.ts', [
  './evidence-query.ts',
])
