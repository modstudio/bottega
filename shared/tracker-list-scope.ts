export type ToolInputSchema = {
  properties?: Record<string, unknown>
}

export type ToolListingCaller = {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  listTools?: () => Promise<{ name: string; inputSchema: ToolInputSchema }[]>
}

export async function advertisedToolSchema(
  caller: ToolListingCaller,
  toolName: string,
): Promise<ToolInputSchema | undefined> {
  const tools = await caller.listTools?.()
  return tools?.find((candidate) => candidate.name === toolName)?.inputSchema
}

export async function toolDeclaresInput(
  caller: ToolListingCaller,
  toolName: string,
  field: string,
): Promise<boolean> {
  const schema = await advertisedToolSchema(caller, toolName)
  return field in (schema?.properties ?? {})
}

export function scopedRows<Row extends Record<string, unknown>>(
  rows: Row[],
  field: keyof Row & string,
  scope: string,
  refusal: string,
): Row[] {
  if (rows.some((row) => typeof row[field] !== 'string')) {
    throw new Error(refusal)
  }
  return rows.filter((row) => row[field] === scope)
}
