#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-port-boundary', 'orchestrator/src/schema-port.ts', [
  './schema-core.ts',
  './schema-review.ts',
])
