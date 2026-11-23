import { join } from 'node:path'
import { GATE_FACTS_ENV, writeGateFacts } from '../gate/gate-facts.ts'

export async function installRunGateFacts(
  scratchDir: string,
  launchEnvironment: Record<string, string>,
  sandboxEnvironment: Record<string, string>,
): Promise<void> {
  const path = join(scratchDir, 'gate-facts.json')
  try {
    await writeGateFacts(path)
  } catch (cause) {
    throw new Error(
      `refusing dispatch: authoritative gate facts could not be written: ${String((cause as Error).message ?? cause)}; remedy: verify record access and retry the run`,
    )
  }
  launchEnvironment[GATE_FACTS_ENV] = path
  sandboxEnvironment[GATE_FACTS_ENV] = path
}
