// concern: authoritative-document-read
/** Prefetches each authoritative document slice used by write-time pack projection. */

import { type Doc, readDocs } from './doc-authoritative-read.ts'

const PACK_CONTEXT_SLUG_PREFIX = '.agents/contexts/'

export type PackBudgetProjection = {
  globalDocs: Doc[]
  jobDocs: Map<string, Doc[]>
  projectDocs: Map<string, Doc[]>
  globalCanon: Doc[]
  projectCanon: Map<string, Doc[]>
}

export async function authoritativePackBudgetProjection(
  projectNames: string[],
  jobNames: string[],
): Promise<PackBudgetProjection> {
  const [globalDocs, globalCanon, jobRows, projectRows, projectCanonRows] = await Promise.all([
    readDocs({ scope: 'global', subject: null, status: 'current', delivery: 'inject' }),
    readDocs({
      scope: 'canon',
      subject: null,
      status: 'current',
      frontmatterOnly: [PACK_CONTEXT_SLUG_PREFIX],
    }),
    Promise.all(
      jobNames.map(
        async (job) =>
          [
            job,
            await readDocs({
              scope: 'job',
              subject: job,
              status: 'current',
              delivery: 'inject',
            }),
          ] as const,
      ),
    ),
    Promise.all(
      projectNames.map(
        async (project) =>
          [
            project,
            await readDocs({
              scope: 'project',
              subject: project,
              status: 'current',
              delivery: 'inject',
            }),
          ] as const,
      ),
    ),
    Promise.all(
      projectNames.map(
        async (project) =>
          [
            project,
            await readDocs({
              scope: 'canon',
              subject: project,
              status: 'current',
              frontmatterOnly: [PACK_CONTEXT_SLUG_PREFIX],
            }),
          ] as const,
      ),
    ),
  ])
  return {
    globalDocs,
    globalCanon,
    jobDocs: new Map(jobRows),
    projectDocs: new Map(projectRows),
    projectCanon: new Map(projectCanonRows),
  }
}
