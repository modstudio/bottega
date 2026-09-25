/** Builds hosted canon write-gate facts. Must not know local stores, CLI, or HTTP. */
import type { SQL } from 'bun'
import type { CanonFinding } from '../canon/canon-lint.ts'
import { decideCanonWrite, decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { composeCanonRows, refuseCanonWrite } from '../doc/doc-write-allowed.ts'

type Row = { slug: string; body: string }
const asRows = (rows: Record<string, unknown>[]): Row[] =>
  rows.map((row) => ({ slug: String(row.slug), body: String(row.body) }))
const replace = (rows: Row[], slug: string, body: string): Row[] => [
  ...rows.filter((row) => row.slug !== slug),
  { slug, body },
]
const bodies = <T extends Row>(rows: T[]) => rows.map(({ slug, body }) => ({ slug, body }))

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
    const rows = name
      ? await tx`
          SELECT slug, body FROM doc
          WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject=${name}
            AND owner_user_id IS NULL AND deleted_at IS NULL
        `
      : []
    const project = asRows(rows)
    const current = composeRefusal(() => compose(global, user, project, owner, name))
    if (current.refusal) return current.refusal
    const next = composeRefusal(() => compose(global, changed, project, owner, name))
    if (next.refusal) return next.refusal
    const refusal = refuseCanonWrite({ current: current.rows, next: next.rows })
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

export async function userCanonImportFindings(
  tx: SQL,
  input: { spaceId: string; owner: string; current: Row[]; next: Row[]; bootstrap: boolean },
): Promise<CanonFinding[]> {
  const global = asRows(
    await tx`
      SELECT slug, body FROM doc
      WHERE space_id=${input.spaceId}::uuid AND scope='canon' AND subject IS NULL
        AND owner_user_id IS NULL AND deleted_at IS NULL
    `,
  )
  const names = await managedCanonProjectNames(tx, input.spaceId)
  const targets = names.length ? names : [null]
  const findings: CanonFinding[] = []
  for (const name of targets) {
    const project = name
      ? asRows(
          await tx`
            SELECT slug, body FROM doc
            WHERE space_id=${input.spaceId}::uuid AND scope='canon' AND subject=${name}
              AND owner_user_id IS NULL AND deleted_at IS NULL
          `,
        )
      : []
    const current = compose(global, input.current, project, input.owner, name)
    const next = compose(global, input.next, project, input.owner, name)
    if (input.bootstrap) {
      findings.push(...decideUserCanonImport({ current: [], next }).findings)
      continue
    }
    let working = input.current
    for (const row of input.next) {
      const changed = replace(working, row.slug, row.body)
      const before = compose(global, working, project, input.owner, name)
      const after = compose(global, changed, project, input.owner, name)
      const introduced = decideCanonWrite({ current: before, next: after })
      if (introduced.length) {
        findings.push(...introduced)
        break
      }
      working = changed
    }
    if (!findings.length) findings.push(...decideCanonWrite({ current, next }))
  }
  return [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()]
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
  const globalRows = asRows(
    await tx`
    SELECT slug, body FROM doc
    WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject IS NULL AND owner_user_id IS NULL AND deleted_at IS NULL
  `,
  )
  const userRows = owner
    ? asRows(
        await tx`
        SELECT slug, body, owner_user_id FROM doc
        WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject IS NULL
          AND owner_user_id=${owner}::uuid AND deleted_at IS NULL
      `,
      )
    : []
  const projectRows = subject
    ? asRows(
        await tx`
        SELECT slug, body FROM doc
        WHERE space_id=${spaceId}::uuid AND scope='canon' AND subject=${subject} AND deleted_at IS NULL
      `,
      )
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
    nextCanon: next.rows,
    canonRefusal,
  }
}
