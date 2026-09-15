#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-project-lock-boundary', 'orchestrator/src/project-lock.ts', [
  './db.ts',
  './git-environment.ts',
  '../../shared/process-identity.ts',
])
