#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-core-boundary', 'orchestrator/src/schema-core.ts', [
  '../../shared/docs.ts',
  './run-authority.ts',
  './score.ts',
])
