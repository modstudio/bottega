// concern: doc-command-check
/** Adapts the generated command set to the pure customer-guide command decision. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_COMMAND_WORDS } from '../../../shared/command-spellings.ts'
import { assertDocSections } from '../../../shared/doc-sections.ts'
import type { DocAudiences } from '../../../shared/docs.ts'
import { type UnknownCommandMention, unknownCommandMentions } from './doc-command-mentions.ts'

export type CustomerGuideCommandCheck = {
  findings: UnknownCommandMention[]
}

export type CustomerGuideCommandInput = {
  body: string
  kind: string
  form: string | null
  audiences: readonly string[]
}

const loadGeneratedCommands = (): readonly string[] =>
  PLATFORM_COMMAND_WORDS.map((words) => `${PLATFORM_SLUG} ${words}`)

export function checkCustomerGuideCommands(
  input: CustomerGuideCommandInput,
): CustomerGuideCommandCheck {
  if (
    input.kind !== 'article' ||
    input.form === 'reference' ||
    !input.audiences.includes('customer')
  ) {
    return { findings: [] }
  }
  return { findings: unknownCommandMentions(input.body, loadGeneratedCommands()) }
}

export function customerGuideCommandRefusal(
  findings: readonly UnknownCommandMention[],
): string | null {
  if (!findings.length) return null
  return (
    `refusing customer guide write; unknown command mention${findings.length === 1 ? '' : 's'}:\n` +
    findings.map(({ mention }) => `- ${mention}`).join('\n') +
    `\ncleared by: correct the named mentions; ${PLATFORM_SLUG} --help lists the commands`
  )
}

function assertCustomerGuideCommands(input: CustomerGuideCommandInput): void {
  const checked = checkCustomerGuideCommands(input)
  const refusal = customerGuideCommandRefusal(checked.findings)
  if (refusal) throw new Error(refusal)
}

function assertDocCommands(
  input: { body: string },
  fields: Omit<CustomerGuideCommandInput, 'body' | 'audiences'> & { audiences: DocAudiences },
): void {
  assertCustomerGuideCommands({ body: input.body, ...fields })
}

export function assertDocBodyCommands(
  input: { body: string },
  fields: Omit<CustomerGuideCommandInput, 'body' | 'audiences'> & { audiences: DocAudiences },
): void {
  assertDocSections(input.body, fields.audiences)
  assertDocCommands(input, fields)
}
