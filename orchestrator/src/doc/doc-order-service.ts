// concern: document-order-service
/** Applies a complete sibling document order through the authoritative store. */

import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { readDocs } from './doc-authoritative-read.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import { type DocOrderInput, docOrderRefusal } from './doc-order.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
import { executeLocalDocOrder } from './local-doc-order.ts'

export async function reorderDocs(input: DocOrderInput): Promise<{ orderedIds: string[] }> {
  assertWorkerDocStoreWriteAllowed('reorderDocs')
  return applyRecordWriteAuthority({
    local: () => executeLocalDocOrder(input),
    hosted: async () => {
      const siblings = (await readDocs({ scope: input.scope, subject: input.subject })).filter(
        (doc) => doc.parent_record_id === input.parentId,
      )
      const refusal = docOrderRefusal(
        siblings.map((row) => row.record_id),
        input.orderedIds,
      )
      if (refusal) throw new Error(refusal)
      const client = await hostedDocClient(input.scope, input.subject)
      return client.reorderDocs(input)
    },
  })
}
