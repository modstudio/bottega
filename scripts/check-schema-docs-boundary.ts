#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-schema-docs-boundary', 'orchestrator/src/schema-docs.ts', [
  '../../shared/docs.ts',
  './schema-core.ts',
])
