type ToolListingCaller = {
  listTools?: () => Promise<
    { name: string; inputSchema: { properties?: Record<string, unknown> } }[]
  >
}

export async function toolDeclaresInput(
  caller: ToolListingCaller,
  toolName: string,
  field: string,
): Promise<boolean> {
  const tools = await caller.listTools?.()
  if (!tools) return false
  const tool = tools.find((candidate) => candidate.name === toolName)
  return field in (tool?.inputSchema.properties ?? {})
}

export function scopedRows<Row extends Record<string, unknown>>(
  rows: Row[],
  field: keyof Row & string,
  scope: string,
  refusal: string,
): Row[] {
  if (!rows.length || rows.some((row) => typeof row[field] !== 'string')) {
    throw new Error(refusal)
  }
  return rows.filter((row) => row[field] === scope)
}
