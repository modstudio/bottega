#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-sandbox-boundary', 'orchestrator/src/sandbox.ts', [
  './db.ts',
  './mcp-probe.ts',
  './projects.ts',
])
