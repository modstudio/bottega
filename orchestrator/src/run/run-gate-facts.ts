import { join } from 'node:path'
import { GATE_FACTS_ENV, writeGateFacts } from '../gate/gate-facts.ts'

export async function prepareRunGateFacts(scratchDir: string): Promise<Record<string, string>> {
  const path = join(scratchDir, 'gate-facts.json')
  try {
    await writeGateFacts(path)
  } catch (cause) {
    throw new Error(
      `refusing dispatch: authoritative gate facts could not be written: ${String((cause as Error).message ?? cause)}; remedy: verify record access and retry the run`,
    )
  }
  return { [GATE_FACTS_ENV]: path }
}
