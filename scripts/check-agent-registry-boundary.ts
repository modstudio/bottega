#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-agent-registry-boundary', 'orchestrator/src/agent-registry.ts', [
  './agents.ts',
  './capabilities.ts',
  './db.ts',
])
