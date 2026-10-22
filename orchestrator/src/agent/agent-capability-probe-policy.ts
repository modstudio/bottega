// concern: observed registration capability policy
/** ACP capabilities are probe-owned; CLI capabilities remain declaration-owned. */
export function observedCapabilityPolicy(
  transport: 'cli' | 'acp',
  observation: boolean | null | undefined,
): { requiresObservation: boolean; value: boolean | null; jobSuccess: boolean } {
  const requiresObservation = transport === 'acp'
  return {
    requiresObservation,
    value: requiresObservation && observation != null ? observation : null,
    jobSuccess: !requiresObservation || observation === true,
  }
}
