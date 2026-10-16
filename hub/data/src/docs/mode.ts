import { hasRecordIdShape } from '../../../../shared/record-id.ts'
import { canEditDoc } from './edit-permission.ts'
import { docsLocation } from './location.ts'
import type { DataTreeItem, DocsSource } from './use-docs.ts'

export function docsSource(hosted: boolean, signedIn: boolean): DocsSource {
  if (!hosted) return 'local'
  return signedIn ? 'hosted' : 'public'
}

export function docsSourceLabel(source: DocsSource, activeSpaceName?: string): string {
  if (source === 'local') return 'Local store'
  if (source === 'public') return 'Public'
  return activeSpaceName ? `Hosted record · ${activeSpaceName}` : 'Hosted record'
}

export function revisionIdForSource(
  source: DocsSource,
  revisionParam: string | undefined,
): number | string | null {
  if (!revisionParam) return null
  if (source === 'local') return /^\d+$/.test(revisionParam) ? Number(revisionParam) : null
  if (source === 'hosted') return hasRecordIdShape(revisionParam) ? revisionParam : null
  return null
}

/** All adapter-specific answers needed to compose the docs route. */
export function useDocsMode(
  hosted: boolean,
  signedIn: boolean,
  memberships: readonly Record<string, unknown>[] | undefined,
  activeSpaceName?: string,
) {
  const source = docsSource(hosted, signedIn)
  const privateSource = source !== 'public'
  return {
    source,
    label: docsSourceLabel(source, activeSpaceName),
    canEdit: (item: DataTreeItem | null) =>
      Boolean(item && canEditDoc(source, memberships, item.spaceId)),
    locationFor: (item: DataTreeItem) => docsLocation(item, source),
    selectedRevision: (revision: string | number | undefined) =>
      privateSource && revision !== undefined ? String(revision) : undefined,
    includeDrafts: (showDrafts: boolean) => privateSource && showDrafts,
    showWorking: (showWorking: boolean) => privateSource && showWorking,
    canShowDrafts: privateSource,
    canShowWorking: privateSource,
    showHistory: privateSource,
    canCreate: source === 'local',
    isPublic: source === 'public',
  }
}
