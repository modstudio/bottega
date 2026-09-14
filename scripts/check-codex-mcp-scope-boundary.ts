#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary(
  'check-codex-mcp-scope-boundary',
  'orchestrator/src/codex-mcp-scope.ts',
  ['./database-location.ts', './mcp-probe.ts'],
)
