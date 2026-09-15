// concern: contract
/** Owns contract rendering command behavior. Must not know CLI grammar. */
import { contractText } from './contract-text.ts'

export function contractCommand(
  jobName: string,
  presentation: { write(value: string): void },
): void {
  presentation.write(contractText(jobName))
}
