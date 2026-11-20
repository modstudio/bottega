// concern: doctor reporter
/** Defines the neutral presentation port for doctor output. */

export type DoctorReporter = { log(value: string): void; exitCode(code: number): void }
