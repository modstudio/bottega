// concern: calibration-port
/** Knows the calibration evidence routing consumes. Must import nothing. */

export type Calibration = { precision: number | null }
export type CalibrationProvider = (lens: string, agent: string, model: string) => Calibration

let provider: CalibrationProvider | null = null

export function registerCalibrationProvider(next: CalibrationProvider): void {
  provider = next
}

export function calibrationFor(lens: string, agent: string, model: string): Calibration {
  if (!provider) {
    throw new Error(
      'refusing calibration lookup: standard calibration provider is not registered\n' +
        'invariant: Routing consumes review calibration through its registered evidence port.\n' +
        'cleared by: call registerStandardRuntime() before routing',
    )
  }
  return provider(lens, agent, model)
}
