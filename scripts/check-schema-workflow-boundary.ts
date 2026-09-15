#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-workflow-boundary', 'orchestrator/src/schema-workflow.ts', [
  './contention.ts',
  './review-vocabulary.ts',
  './schema-core.ts',
])
