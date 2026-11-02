// concern: hosted document prose gate
/** Checks a hosted document request against its stored current revision, then writes it. */

import { proseGate } from '../../../shared/prose/prose-gate.ts'
import { docProseFields } from '../doc/doc-body-prose.ts'
import { hostedProseOptions } from './record-api-prose.ts'
import type { RecordIdentity } from './record-auth.ts'
import { RecordDocError } from './record-doc-errors.ts'

type DocText = { title: string; summary?: string | null; body: string }
type DocInput = DocText & { scope: string; id?: string | null }

export async function hostedDocUpsert<
  Tenant extends object,
  Input extends DocInput,
  Written extends { writeWarnings?: string[] },
>(
  tenant: Tenant,
  input: Input,
  identity: RecordIdentity | undefined,
  deps: {
    readDoc(input: Tenant & { id: string }): Promise<DocText | null>
    upsertDoc(input: Tenant & Input): Promise<Written>
  },
): Promise<Written> {
  const prior = input.id ? await deps.readDoc({ ...tenant, id: input.id }) : null
  const checked = await proseGate(docProseFields(input, prior), hostedProseOptions(identity))
  if (checked.refusal) throw new RecordDocError(checked.refusal)
  const written = await deps.upsertDoc({ ...tenant, ...input })
  if (!checked.notices.length) return written
  return { ...written, writeWarnings: [...(written.writeWarnings ?? []), ...checked.notices] }
}
