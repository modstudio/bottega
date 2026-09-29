type OutboxPayloadContract = {
  columns: readonly string[]
  laterAdded: Readonly<Record<string, unknown>>
}

export type OutboxPayloadContracts = Readonly<Record<string, OutboxPayloadContract>>
export type OutboxPayloadBaseline = Readonly<Record<string, readonly string[]>>

function knownContractFailures(
  kind: string,
  baseColumns: readonly string[],
  contract: OutboxPayloadContract,
): string[] {
  const failures: string[] = []
  const currentColumns = new Set(contract.columns)
  const baseColumnSet = new Set(baseColumns)
  const laterAddedColumns = new Set(Object.keys(contract.laterAdded))
  for (const column of contract.columns) {
    if (!baseColumnSet.has(column) && !laterAddedColumns.has(column)) {
      failures.push(
        `${kind}.${column}: current column is neither a base column nor laterAdded; add a laterAdded fill`,
      )
    }
  }
  for (const column of baseColumns) {
    if (!currentColumns.has(column)) {
      failures.push(
        `${kind}.${column}: base column is no longer current; perform a deliberate migration, never a baseline edit`,
      )
    }
  }
  for (const column of laterAddedColumns) {
    if (!currentColumns.has(column)) {
      failures.push(`${kind}.${column}: laterAdded key is not a current column`)
    }
  }
  return failures
}

export function outboxPayloadContractFailures(
  baseline: OutboxPayloadBaseline,
  contracts: OutboxPayloadContracts,
): string[] {
  const failures: string[] = []
  for (const [kind, contract] of Object.entries(contracts)) {
    const baseColumns = baseline[kind]
    if (!baseColumns) {
      failures.push(`${kind}: new outbox kind; add its base column set to the baseline`)
      continue
    }
    failures.push(...knownContractFailures(kind, baseColumns, contract))
  }
  for (const kind of Object.keys(baseline)) {
    if (!(kind in contracts)) failures.push(`${kind}: stale baseline kind is no longer registered`)
  }
  return failures
}
