#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'
checkModuleBoundary('check-runtime-registration-boundary', 'orchestrator/src/runtime-registration.ts', [
  './standard-calibration.ts', './store-hooks.ts', './standard-transports.ts',
])
