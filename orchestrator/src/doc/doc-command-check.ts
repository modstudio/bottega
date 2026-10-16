// concern: doc-command-check
/** Adapts the generated command set to the pure customer-guide command decision. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_COMMANDS } from '../../../shared/command-spellings.ts'
import { assertDocSections } from '../../../shared/doc-sections.ts'
import type { DocAudiences } from '../../../shared/docs.ts'
import { type UnknownCommandMention, unknownCommandMentions } from './doc-command-mentions.ts'

export type CustomerGuideCommandCheck = {
  findings: UnknownCommandMention[]
  warning: string | null
}

export type CustomerGuideCommandInput = {
  body: string
  kind: string
  form: string | null
  audiences: readonly string[]
}

const loadGeneratedCommands = (): readonly string[] => PLATFORM_COMMANDS

export function checkCustomerGuideCommands(
  input: CustomerGuideCommandInput,
  loadCommands: () => readonly string[] = loadGeneratedCommands,
): CustomerGuideCommandCheck {
  if (
    input.kind !== 'article' ||
    input.form === 'reference' ||
    !input.audiences.includes('customer')
  ) {
    return { findings: [], warning: null }
  }
  try {
    return { findings: unknownCommandMentions(input.body, loadCommands()), warning: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      findings: [],
      warning: `customer guide command check unavailable: ${detail}; the write was allowed`,
    }
  }
}

export function customerGuideCommandRefusal(
  findings: readonly UnknownCommandMention[],
): string | null {
  if (!findings.length) return null
  return (
    `refusing customer guide write; unknown command mention${findings.length === 1 ? '' : 's'}:\n` +
    findings
      .map(({ mention, replacement }) =>
        replacement ? `- ${mention}; use ${replacement}` : `- ${mention}`,
      )
      .join('\n') +
    `\ncleared by: correct the named mentions; ${PLATFORM_SLUG} --help lists the commands`
  )
}

function assertCustomerGuideCommands(
  input: CustomerGuideCommandInput,
  loadCommands?: () => readonly string[],
): string | null {
  const checked = checkCustomerGuideCommands(input, loadCommands)
  const refusal = customerGuideCommandRefusal(checked.findings)
  if (refusal) throw new Error(refusal)
  return checked.warning
}

function assertDocCommands(
  input: { body: string; loadKnownCommands?: () => readonly string[] },
  fields: Omit<CustomerGuideCommandInput, 'body' | 'audiences'> & { audiences: DocAudiences },
): string | null {
  return assertCustomerGuideCommands({ body: input.body, ...fields }, input.loadKnownCommands)
}

export function assertDocBodyCommands(
  input: { body: string; loadKnownCommands?: () => readonly string[] },
  fields: Omit<CustomerGuideCommandInput, 'body' | 'audiences'> & { audiences: DocAudiences },
): string | null {
  assertDocSections(input.body, fields.audiences)
  return assertDocCommands(input, fields)
}
