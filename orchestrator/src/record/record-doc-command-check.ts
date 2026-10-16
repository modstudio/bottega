// concern: record-doc-command-check
/** Applies the customer-guide command refusal through the hosted record error contract. */

import {
  checkCustomerGuideCommands,
  type CustomerGuideCommandInput,
  customerGuideCommandRefusal,
} from '../doc/doc-command-check.ts'
import { assertWrite } from './record-doc-errors.ts'

export function assertRecordCustomerGuideCommands(input: CustomerGuideCommandInput): string | null {
  const checked = checkCustomerGuideCommands(input)
  assertWrite(customerGuideCommandRefusal(checked.findings))
  return checked.warning
}
