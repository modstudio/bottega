import type { DocSnippetHighlight } from '../../../../shared/doc-snippet.ts'
import type {
  DocArticleSubject,
  DocAudience,
  DocAudiences,
  DocForm,
  DocKind,
  DocStatus,
} from '../../../../shared/docs.ts'

export type DocsAudience = DocAudience
type DocsDelivery = 'inject' | 'demand'

/** Shared tree item, matching `hub/src/doc-contract.ts`, plus delivery when the source has it. */
export type DocsTreeItem = {
  id: string
  /** Hosted record space that owns this document. */
  spaceId?: string
  slug: string
  title: string
  parentId: string | null
  position: number
  updatedAt: string
  scope: string
  subject: string | null
  audiences: DocAudiences
  status: DocStatus
  kind: DocKind
  form?: DocForm | null
  replacementSlug: string | null
  delivery?: DocsDelivery
  summary?: string
  summarySource: 'written' | 'derived'
  featured?: boolean
  /** Set when the adapter says this document belongs to a project. */
  projectName?: string
}

export type DocsDoc = DocsTreeItem & {
  body: string
  articleSubject?: DocArticleSubject | null
  relatedSubjects?: DocArticleSubject[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
}

export type DocsSearchMatch = {
  id: string
  slug: string
  title: string
  status: DocStatus
  kind: DocKind
  audiences: DocAudiences
  snippet: string
  summary: string
  summarySource: 'written' | 'derived'
  spaceName?: string
  highlights: DocSnippetHighlight[]
}

export type TreeNode = DocsTreeItem & { children: TreeNode[]; navigationDisabled: boolean }

export type DocsTreeGroup = { heading: string; children: TreeNode[] }
