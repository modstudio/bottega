// concern: runtime-registration
/** Connects application entrypoints to the standard store, calibration, and transport adapters. */
import { registerStandardCalibration } from './standard-calibration.ts'
import { registerStandardTransports } from './standard-transports.ts'
import { registerStandardHooks } from './store-hooks.ts'

export function registerStandardRuntime(): void {
  registerStandardHooks()
  registerStandardCalibration()
  registerStandardTransports()
}
