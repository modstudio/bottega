#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'
checkModuleBoundary('check-standard-transports-boundary', 'orchestrator/src/standard-transports.ts', [
  './transport-acp.ts', './transport-cli.ts',
])
