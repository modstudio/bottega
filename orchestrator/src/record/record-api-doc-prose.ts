// concern: hosted document prose gate
/** Checks a hosted document request against its stored current revision, then writes it. */

import { proseGate } from '../../../shared/prose/prose-gate.ts'
import { RecordDocError } from './record-doc-errors.ts'

type DocText = { title: string; summary?: string | null; body: string }

export async function hostedDocUpsert<
  Tenant extends object,
  Input extends DocText & { id?: string | null },
  Written extends { writeWarnings?: string[] },
>(
  tenant: Tenant,
  input: Input,
  identity: { user: Record<string, unknown> } | undefined,
  deps: {
    readDoc(input: Tenant & { id: string }): Promise<DocText | null>
    upsertDoc(input: Tenant & Input): Promise<Written>
  },
): Promise<Written> {
  const prior = input.id ? await deps.readDoc({ ...tenant, id: input.id }) : null
  const checked = await proseGate(
    [
      { field: 'title', text: input.title, prior: prior?.title ?? null },
      { field: 'summary', text: input.summary ?? '', prior: prior?.summary ?? null },
      { field: 'body', text: input.body, prior: prior?.body ?? null },
    ],
    {
      displayName: typeof identity?.user.name === 'string' ? identity.user.name : null,
      enabled: process.env.BOTTEGA_PROSE_CHECK !== 'off',
    },
  )
  if (checked.refusal) throw new RecordDocError(checked.refusal)
  const written = await deps.upsertDoc({ ...tenant, ...input })
  if (!checked.notices.length) return written
  return { ...written, writeWarnings: [...(written.writeWarnings ?? []), ...checked.notices] }
}
