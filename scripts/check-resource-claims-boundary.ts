#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-resource-claims-boundary', 'orchestrator/src/resource-claims.ts', [])
