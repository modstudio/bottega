import { classifyCaller } from '../../shared/caller-classification.ts'

/** The session identity the orchestrator will stamp on a workflow cursor for this caller. */
export function callerSession(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const caller = classifyCaller(env)
  return caller.kind === 'harness' ? caller.session : null
}
