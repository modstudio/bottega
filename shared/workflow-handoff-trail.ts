/** Render the stable trail entries only after the successor's display number is allocated. */
export function workflowHandoffTrail(input: {
  closed: unknown[]
  current: { n: number; slug: string }
  remaining: Array<{ n: number; slug: string }>
  targetWorkflow: string
  successorNumber: number
  reason: string
  at: string
}): unknown[] {
  return [
    ...input.closed,
    {
      ...input.current,
      note: `handed off to ${input.targetWorkflow} (cursor ${input.successorNumber}): ${input.reason}`,
      at: input.at,
    },
    ...input.remaining.map((step) => ({ ...step, note: 'not run: handed off', at: input.at })),
  ]
}
