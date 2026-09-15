#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-capabilities-boundary', 'orchestrator/src/capabilities.ts', [])
