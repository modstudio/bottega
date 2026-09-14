// concern: standard-calibration
/** Connects the review calibration adapter to routing's calibration port. */
import { registerCalibrationProvider } from './calibration-port.ts'
import { reviewCalibration } from './review-calibration.ts'

export function registerStandardCalibration(): void {
  registerCalibrationProvider(reviewCalibration)
}
