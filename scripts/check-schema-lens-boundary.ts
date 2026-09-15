#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-lens-boundary', 'orchestrator/src/schema-lens.ts', [
  './schema-core.ts',
])
