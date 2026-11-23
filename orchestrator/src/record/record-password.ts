import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const RECORD_PASSWORD_ENV = `${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD`
const NON_INTERACTIVE_PASSWORD_REFUSAL = `record password is required: stdin is not a terminal; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`
export const PASSWORD_PROMPT_EOF_REFUSAL = `record password prompt ended before a password was entered; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`

type RecordPasswordDecision =
  | { action: 'use-environment'; password: string }
  | { action: 'prompt' }
  | { action: 'refuse'; message: string }

export function decideRecordPassword(
  passwordFromEnvironment: string | undefined,
  stdinIsTerminal: boolean,
): RecordPasswordDecision {
  if (passwordFromEnvironment !== undefined) {
    return { action: 'use-environment', password: passwordFromEnvironment }
  }
  if (stdinIsTerminal) return { action: 'prompt' }
  return { action: 'refuse', message: NON_INTERACTIVE_PASSWORD_REFUSAL }
}
