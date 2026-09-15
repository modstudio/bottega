#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-serve-lifecycle-boundary', 'hub/src/serve-lifecycle.ts', [
  '../../shared/process-identity.ts',
])
