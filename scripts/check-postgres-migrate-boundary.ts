#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-postgres-migrate-boundary', 'orchestrator/src/postgres-migrate.ts', [])
