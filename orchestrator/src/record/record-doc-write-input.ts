// concern: record-doc-write-input
/** Declares the hosted document write boundary. */

import type { DocAudiences, DocForm, DocKind, DocStatus } from '../../../shared/docs.ts'
import type { TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { DocGenerator } from '../doc/doc-generator.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'

export type RecordDocWriteInput = { url: string } & TenantPrincipal & {
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    title: string
    body: string
    delivery?: DocDelivery
    audiences?: DocAudiences
    parentRecordId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    replacementSlug?: string | null
    projectName?: string | null
    projectId?: string | null
    reason: string
    author: string
    sessionId?: string | null
    forceInject?: string
    op?: DocRevisionOp
    at?: string
    id?: string
    revisionId?: string
    expectedRevision?: string
    generator?: DocGenerator
  }
