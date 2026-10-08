/** Builds hosted canon write-gate facts. Must not know local stores, CLI, or HTTP. */
import type { SQL } from 'bun'
import { decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { canonFindingsRefusal, composeCanonRows } from '../doc/doc-write-allowed.ts'

type Row = { slug: string; body: string }
const asRows = (rows: Record<string, unknown>[]): Row[] =>
  rows.map((row) => ({ slug: String(row.slug), body: String(row.body) }))
const replace = (rows: Row[], slug: string, body: string): Row[] => [
  ...rows.filter((row) => row.slug !== slug),
  { slug, body },
]
const bodies = <T extends Row>(rows: T[]) => rows.map(({ slug, body }) => ({ slug, body }))

async function liveCurrentCanonRows(
  tx: SQL,
  spaceId: string,
  address: { subject: string | null; owner: string | null },
): Promise<Row[]> {
  const rows = address.owner
    ? await tx`
        SELECT slug, body FROM doc
        WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject IS NULL
          AND owner_user_id=${address.owner}::uuid AND deleted_at IS NULL AND status='current'
      `
    : address.subject
      ? await tx`
          SELECT slug, body FROM doc
          WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject=${address.subject}
            AND owner_user_id IS NULL AND deleted_at IS NULL AND status='current'
        `
      : await tx`
          SELECT slug, body FROM doc
          WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject IS NULL
            AND owner_user_id IS NULL AND deleted_at IS NULL AND status='current'
        `
  return asRows(rows)
}

function compose(
  global: Row[],
  user: Row[],
  project: Row[],
  owner: string | null,
  subject: string | null,
): Row[] {
  return bodies(
    composeCanonRows(
      global.map((row) => ({ ...row, subject: null })),
      user.map((row) => ({ ...row, subject: null, owner })),
      project.map((row) => ({ ...row, subject })),
    ),
  )
}

function composeRefusal(build: () => Row[]): { rows: Row[]; refusal: string | null } {
  try {
    return { rows: build(), refusal: null }
  } catch (error) {
    return { rows: [], refusal: error instanceof Error ? error.message : String(error) }
  }
}

async function userWriteRefusal(
  tx: SQL,
  spaceId: string,
  owner: string,
  global: Row[],
  user: Row[],
  changed: Row[],
): Promise<string | null> {
  const names = await managedCanonProjectNames(tx, spaceId)
  const targetNames = names.length ? names : [null]
  for (const name of targetNames) {
    const project = name
      ? await liveCurrentCanonRows(tx, spaceId, { subject: name, owner: null })
      : []
    const current = composeRefusal(() => compose(global, user, project, owner, name))
    if (current.refusal) return current.refusal
    const next = composeRefusal(() => compose(global, changed, project, owner, name))
    if (next.refusal) return next.refusal
    const findings = decideUserCanonImport({
      current: user,
      next: changed,
      surroundings: [{ global, project }],
    }).findings
    const refusal = canonFindingsRefusal(findings)
    if (refusal) return refusal
  }
  return null
}

export async function managedCanonProjectNames(tx: SQL, spaceId: string): Promise<string[]> {
  const targets = await tx`
    SELECT name FROM project
    WHERE space_id=${spaceId}::uuid
      AND retired_at IS NULL
      AND managed_context
    ORDER BY name
  `
  return targets.map((row: Record<string, unknown>) => String(row.name))
}

export async function recordCanonImportSurroundings(
  tx: SQL,
  input: { spaceId: string; address: { kind: 'user' } | { kind: 'project'; subject: string } },
): Promise<Array<{ global: Row[]; project: Row[] }>> {
  const global = await liveCurrentCanonRows(tx, input.spaceId, { subject: null, owner: null })
  if (input.address.kind === 'project') return [{ global, project: [] }]
  const names = await managedCanonProjectNames(tx, input.spaceId)
  const targets = names.length ? names : [null]
  const surroundings: Array<{ global: Row[]; project: Row[] }> = []
  for (const name of targets) {
    const project = name
      ? await liveCurrentCanonRows(tx, input.spaceId, { subject: name, owner: null })
      : []
    surroundings.push({ global, project })
  }
  return surroundings
}

export async function canonFacts(
  tx: SQL,
  spaceId: string,
  scope: string,
  subject: string | null,
  slug: string,
  body: string,
  owner: string | null = null,
) {
  if (scope !== 'canon') {
    return {
      globalCanonSlugs: [] as string[],
      projectCanonSlugs: [] as string[],
      currentCanon: [] as Row[],
      nextCanon: [] as Row[],
      canonRefusal: null,
    }
  }
  const globalRows = await liveCurrentCanonRows(tx, spaceId, { subject: null, owner: null })
  const userRows = owner ? await liveCurrentCanonRows(tx, spaceId, { subject: null, owner }) : []
  const projectRows = subject
    ? await liveCurrentCanonRows(tx, spaceId, { subject, owner: null })
    : []
  const changed = replace(owner ? userRows : subject ? projectRows : globalRows, slug, body)
  const current = composeRefusal(() => compose(globalRows, userRows, projectRows, owner, subject))
  const next = composeRefusal(() =>
    compose(
      owner || subject ? globalRows : changed,
      owner ? changed : userRows,
      subject ? changed : projectRows,
      owner,
      subject,
    ),
  )
  let canonRefusal = current.refusal ?? next.refusal
  if (owner && !canonRefusal) {
    canonRefusal = await userWriteRefusal(tx, spaceId, owner, globalRows, userRows, changed)
  }
  return {
    globalCanonSlugs: globalRows.map((row) => row.slug),
    projectCanonSlugs: projectRows.map((row) => row.slug),
    currentCanon: current.rows,
    nextCanon: owner ? current.rows : next.rows,
    canonRefusal,
  }
}
