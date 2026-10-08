import type { DocStatus } from '../../../../shared/docs.ts'

export type DocsAudience = 'user' | 'technical'
type DocsDelivery = 'inject' | 'demand'

/** Shared tree item, matching `hub/src/doc-contract.ts`, plus delivery when the source has it. */
export type DocsTreeItem = {
  id: string
  slug: string
  title: string
  parentId: string | null
  position: number
  updatedAt: string
  scope: string
  subject: string | null
  audience: DocsAudience
  status: DocStatus
  replacementSlug: string | null
  delivery?: DocsDelivery
  summary?: string
  featured?: boolean
  /** Set when the adapter says this document belongs to a project. */
  projectName?: string
}

export type DocsDoc = DocsTreeItem & { body: string }

export type DocsSearchMatch = {
  id: string
  slug: string
  title: string
  status: DocStatus
  snippet: string
  spaceName?: string
  matchPosition: number | null
}

export type DocsSource = 'local' | 'hosted' | 'public'

export type TreeNode = DocsTreeItem & { children: TreeNode[] }

export type DocsTreeGroup = { heading: string; children: TreeNode[] }

export function docsSource(hosted: boolean, signedIn: boolean): DocsSource {
  if (!hosted) return 'local'
  return signedIn ? 'hosted' : 'public'
}
