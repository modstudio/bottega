// concern: terminal input without echo

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

export async function promptHidden(
  prompt: string,
  eofRefusal: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  let muted = false
  const mutedOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk)
      callback()
    },
  }) as Writable & { isTTY: boolean }
  mutedOutput.isTTY = true
  const terminal = createInterface({ input, output: mutedOutput, terminal: true })
  try {
    const answer = terminal.question(prompt)
    muted = true
    const value = await Promise.race([
      answer,
      new Promise<never>((_resolve, reject) => {
        terminal.once('close', () => reject(new Error(eofRefusal)))
      }),
    ])
    muted = false
    output.write('\n')
    return value
  } finally {
    terminal.close()
  }
}
