// concern: record-doc-command-check
/** Applies the customer-guide command refusal through the hosted record error contract. */

import {
  checkCustomerGuideCommands,
  customerGuideCommandRefusal,
} from '../doc/doc-command-check.ts'
import { assertWrite } from './record-doc-errors.ts'

export function checkRecordCommands(
  input: { body: string },
  kind: string,
  form: string | null,
  audiences: readonly string[],
): string | null {
  const checked = checkCustomerGuideCommands({ body: input.body, kind, form, audiences })
  assertWrite(customerGuideCommandRefusal(checked.findings))
  return checked.warning
}
