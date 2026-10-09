// concern: docs
/** Gathers stored canon and shared workflow facts for the pure removal decision. */

import type { CanonLintInputCollector } from '../canon/canon-files.ts'
import { composeCanonRows } from '../canon/canon-hydrate.ts'
import { decideCanonRemoval } from '../canon/canon-write-gate.ts'
import { projectByName } from '../project/projects.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import type { Doc } from './doc-read-store.ts'
import { listDocsStore } from './doc-read-store.ts'
import { type CanonWriteTree, canonRemovalRefusal } from './doc-write-allowed.ts'

const withoutSlug = (rows: Doc[], slug: string) => rows.filter((row) => row.slug !== slug)
const canonRows = (global: Doc[], project: Doc[]) =>
  composeCanonRows(global, [], project).map(({ slug, body }) => ({ slug, body }))

function removalRefusalForView(input: {
  subject: string | null
  current: { slug: string; body: string }[]
  next: { slug: string; body: string }[]
  workflowSteps: { slug: string; body: string }[]
  selectedTree?: CanonWriteTree
  collectCanonLintInput: CanonLintInputCollector
}): string | null {
  const project = input.subject ? projectByName(input.subject) : null
  const root =
    project && input.selectedTree?.project.name === project.name
      ? input.selectedTree.root
      : project?.path
  const tree = root ? input.collectCanonLintInput(root) : undefined
  return canonRemovalRefusal(
    decideCanonRemoval({
      current: input.current,
      next: input.next,
      workflowSteps: input.workflowSteps,
      trackedPaths: tree?.trackedPaths,
      packageScripts: tree?.packageScripts,
      sourceTexts: tree?.sourceTexts,
    }),
  )
}

/** Checks one removal against every stored canon view that can see the removed row. */
export function storedCanonRemovalRefusal(
  doc: Doc,
  selectedTree: CanonWriteTree | undefined,
  collectCanonLintInput: CanonLintInputCollector,
): string | null {
  const workflowSteps = productionWorkflowTree().steps.map(({ slug, body }) => ({ slug, body }))
  if (doc.owner) {
    const current = listDocsStore({ scope: 'canon', subject: null, owner: doc.owner })
    return canonRemovalRefusal(
      decideCanonRemoval({ current, next: withoutSlug(current, doc.slug), workflowSteps }),
    )
  }

  const stored = listDocsStore({ scope: 'canon' })
  const global = stored.filter((row) => row.subject === null)
  const subjects: (string | null)[] =
    doc.subject === null
      ? [...new Set(stored.flatMap((row) => (row.subject === null ? [] : [row.subject])))]
      : [doc.subject]
  if (subjects.length === 0) subjects.push(null)

  for (const subject of subjects) {
    const project = subject === null ? [] : stored.filter((row) => row.subject === subject)
    const current = canonRows(global, project)
    const next = canonRows(
      doc.subject === null ? withoutSlug(global, doc.slug) : global,
      doc.subject === null ? project : withoutSlug(project, doc.slug),
    )
    const refusal = removalRefusalForView({
      subject,
      current,
      next,
      workflowSteps,
      selectedTree,
      collectCanonLintInput,
    })
    if (refusal) return refusal
  }
  return null
}
