/** Pure collision policy shared by local and hosted canon import adapters. */
export function nonCurrentCanonCollisionRefusal(input: {
  rows: Array<{ slug: string; status: string }>
  desiredSlugs: Iterable<string>
  address: { kind: 'user' } | { kind: 'project'; subject: string }
}): string | null {
  const desired = new Set(input.desiredSlugs)
  const collision = input.rows.find((row) => row.status !== 'current' && desired.has(row.slug))
  if (!collision) return null
  const selector =
    input.address.kind === 'user'
      ? '--scope canon --user'
      : `--scope canon --subject ${input.address.subject}`
  const rowAddress = `canon/${input.address.kind === 'user' ? '_' : input.address.subject}/${collision.slug}`
  return (
    `refusing canon import: ${rowAddress} is ${collision.status} and collides with the imported path; ` +
    `cleared by: orch doc status ${collision.slug} ${selector} --status current --reason TEXT, ` +
    `or orch doc rm ${collision.slug} ${selector} --reason TEXT`
  )
}
