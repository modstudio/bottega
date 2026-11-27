// concern: document-write-miss
/** Renders the one refusal shape shared by document write verbs. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DocWriteSpace } from './doc-authoritative-read.ts'
import { docReadsAcrossReadableSpaces } from './doc-space-selection.ts'

export function docWriteMissRefusal(
  scope: string,
  subject: string | null | undefined,
  slug: string,
  owner: string | null,
  selectedSpace?: DocWriteSpace,
): string {
  const spaces = selectedSpace
    ? `record space ${selectedSpace.slug}`
    : docReadsAcrossReadableSpaces({ scope, subject, owner })
      ? 'every readable space'
      : 'the active space'
  return `no ${scope}/${subject ?? '_'} doc ${JSON.stringify(slug)} in ${spaces}; use ${PLATFORM_SLUG} doc list --scope ${scope} to see what exists`
}
