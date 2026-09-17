// concern: standard-calibration
/** Connects the review calibration adapter to routing's calibration port. */

import { reviewCalibration } from '../review/review-calibration.ts'
import { registerCalibrationProvider } from './calibration-port.ts'

export function registerStandardCalibration(): void {
  registerCalibrationProvider(reviewCalibration)
}
