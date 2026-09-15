#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'

checkModuleBoundary('check-codex-schema-boundary', 'orchestrator/src/codex-schema.ts', [])
