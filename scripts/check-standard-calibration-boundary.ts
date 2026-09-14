#!/usr/bin/env bun
import { checkModuleBoundary } from './module-boundary.ts'
checkModuleBoundary('check-standard-calibration-boundary', 'orchestrator/src/standard-calibration.ts', [
  './calibration-port.ts', './review-calibration.ts',
])
