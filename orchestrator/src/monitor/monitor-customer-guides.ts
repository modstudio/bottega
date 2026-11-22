// concern: stale-customer-guide-command-monitor
/** Reports cached customer articles whose command mentions no longer resolve. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { checkCustomerGuideCommands } from '../doc/doc-command-check.ts'
import { readDocs } from '../doc/doc-authoritative-read.ts'
import type { MonitorCondition } from './monitor-types.ts'

export async function staleCustomerGuideCommandConditions(): Promise<MonitorCondition[]> {
  return (await readDocs({ kind: 'article', audience: 'customer', status: 'current' })).flatMap(
    (doc): MonitorCondition[] => {
      const checked = checkCustomerGuideCommands(doc)
      if (!checked.findings.length) return []
      const mentions = checked.findings.map(({ mention }) => mention).join(', ')
      return [
        {
          kind: 'stale-customer-guide-command',
          subject: `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`,
          since: doc.updated_at,
          ageMs: null,
          detail: `customer article "${doc.title}" names unknown command mention${checked.findings.length === 1 ? '' : 's'}: ${mentions}`,
          action: `correct the named article; ${PLATFORM_SLUG} --help lists the commands`,
        },
      ]
    },
  )
}
