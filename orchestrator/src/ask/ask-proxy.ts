import { writeAskServerFailure } from './ask-failure.ts'
import { connectAskLoopback } from './ask-loopback-client.ts'

export async function main(_argv: string[] = []): Promise<number> {
  const value = process.env.BOTTEGA_ASK_URL
  if (!value) throw new Error('BOTTEGA_ASK_URL is required')
  await connectAskLoopback(value)
  return 0
}

export async function runAskProxy(argv: string[] = []): Promise<number> {
  try {
    return await main(argv)
  } catch (error) {
    writeAskServerFailure(error)
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runAskProxy()
}
