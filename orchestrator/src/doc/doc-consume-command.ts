// concern: doc consume command
/** Applies and presents one document consume, delegating resume handoff through a port. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { consumeDoc } from './docs.ts'

type ConsumeFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}

export async function handleDocConsumeCommand(input: {
  sub: string
  argv: string[]
  scope: string | undefined
  subject: string | null
  flags: ConsumeFlags
  log(...values: unknown[]): void
  handoff?(doc: Awaited<ReturnType<typeof consumeDoc>>): Promise<{
    lines: string[]
    [key: string]: unknown
  }>
}): Promise<boolean> {
  if (input.sub !== 'consume') return false
  const slug = input.argv[2]
  if (!slug || !input.scope)
    throw new Error(
      `${PLATFORM_SLUG} doc consume <slug> --scope S [--subject X] [--expect REVISION]`,
    )
  const result = await consumeDoc(input.scope, input.subject, slug, {
    reason: input.flags.flag('reason') ?? 'consumed by session',
    author: input.flags.flag('author'),
    expectedRevision: input.flags.flag('expect'),
  })
  const handoff =
    input.scope === 'resume' && !result.already_consumed && input.handoff
      ? await input.handoff(result)
      : null
  if (input.flags.has('json')) input.log(JSON.stringify({ ...result, handoff }))
  else {
    input.log(
      result.already_consumed
        ? `already consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`
        : `consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`,
    )
    for (const line of handoff?.lines ?? []) input.log(line)
  }
  return true
}
