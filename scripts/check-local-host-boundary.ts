#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-local-host-boundary', 'orchestrator/src/local-host.ts', [
  './agent-registry.ts',
  './agents.ts',
  './db.ts',
])
