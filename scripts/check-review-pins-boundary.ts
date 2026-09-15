#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-review-pins-boundary', 'orchestrator/src/review-pins.ts', [
  './db.ts',
  './git-environment.ts',
  './change-identity.ts',
  './review-types.ts',
])
