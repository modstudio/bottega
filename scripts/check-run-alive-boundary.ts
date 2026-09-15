#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-run-alive-boundary', 'orchestrator/src/run-alive.ts', [])
