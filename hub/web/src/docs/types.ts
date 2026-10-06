export type DocsAudience = 'user' | 'technical'
export type DocsDelivery = 'inject' | 'demand'

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
  delivery?: DocsDelivery
}

export type DocsDoc = DocsTreeItem & { body: string }

export type DocsSearchMatch = {
  id: string
  slug: string
  title: string
  snippet: string
  spaceName?: string
  matchPosition: number | null
}

export type DocsSource = 'local' | 'hosted' | 'public'

export type TreeNode = DocsTreeItem & { children: TreeNode[] }

export function docsSource(hosted: boolean, signedIn: boolean): DocsSource {
  if (!hosted) return 'local'
  return signedIn ? 'hosted' : 'public'
}
