// concern: runtime-registration
/** Connects application entrypoints to the standard store, calibration, and transport adapters. */
import { registerStandardCalibration } from './standard-calibration.ts'
import { registerStandardQuestionRunPusher } from './standard-question-run-pusher.ts'
import { registerStandardTransports } from './standard-transports.ts'
import { registerStandardHooks } from './store-hooks.ts'

export function registerStandardRuntime(): void {
  registerStandardHooks()
  registerStandardCalibration()
  registerStandardQuestionRunPusher()
  registerStandardTransports()
}
