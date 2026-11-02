// concern: hosted document prose gate
/** Checks a hosted document request against its stored current revision. */

import { type ProseGateResult, proseGate } from '../../../shared/prose/prose-gate.ts'

type DocText = { title: string; summary?: string | null; body: string }

export function hostedDocProse(
  input: DocText,
  prior: DocText | null,
  user: Record<string, unknown> | undefined,
): Promise<ProseGateResult> {
  return proseGate(
    [
      { field: 'title', text: input.title, prior: prior?.title ?? null },
      { field: 'summary', text: input.summary ?? '', prior: prior?.summary ?? null },
      { field: 'body', text: input.body, prior: prior?.body ?? null },
    ],
    {
      displayName: typeof user?.name === 'string' ? user.name : null,
      enabled: process.env.BOTTEGA_PROSE_CHECK !== 'off',
    },
  )
}
