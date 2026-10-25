import type { DocScope } from '../../../shared/docs.ts'

type InjectedDocCandidate = {
  delivery: 'inject' | 'demand'
  scope: DocScope
  subject: string | null
}

export function isDocInjectedForRun(
  doc: InjectedDocCandidate,
  job: string,
  projectName: string | null,
): boolean {
  return (
    doc.delivery === 'inject' &&
    ((doc.scope === 'global' && doc.subject === null) ||
      (doc.scope === 'job' && doc.subject === job) ||
      (doc.scope === 'project' && projectName !== null && doc.subject === projectName))
  )
}
