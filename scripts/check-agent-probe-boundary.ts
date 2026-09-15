#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-agent-probe-boundary', 'orchestrator/src/agent-probe.ts', [
  './agent-registry.ts',
  './agents.ts',
  './capabilities.ts',
  './db.ts',
  './jobs.ts',
  './local-host.ts',
  './mcp-probe.ts',
  './transport.ts',
])
