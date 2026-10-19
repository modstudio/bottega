import type { DocAudience, DocAudiences, DocScope } from '../../shared/docs.ts'
import { jsonDocument } from './orch.ts'
import type { DocRevisionMetadata } from './orch-doc-argv.ts'

export type DocRevision = DocRevisionMetadata & {
  doc_record_id: string | null
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
}

export const docRevision = (
  scope: string,
  subject: string | null,
  slug: string,
  revisionId: string | number,
  audience?: DocAudience,
) =>
  jsonDocument<DocRevision>([
    'doc',
    'revision',
    scope,
    subject ?? '-',
    slug,
    String(revisionId),
    ...(audience ? ['--audience', audience] : []),
    '--json',
  ])
