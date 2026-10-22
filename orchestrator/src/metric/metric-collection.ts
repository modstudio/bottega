import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'

export const METRIC_COLLECTION_DEADLINE_MS = 45 * 60 * 1000

export type MetricTranscriptSource = {
  file: string
  modifiedAt: Date
  open(): Readable
}

export type MetricCollectionOptions<Activity> = {
  deadlineMs?: number
  transcripts?: MetricTranscriptSource[]
  activity?: Map<string, Activity>
}

export class MetricCollectionDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private readonly timer: ReturnType<typeof setTimeout>
  private currentFile: string | null = null
  private lastFile: string | null = null

  constructor(readonly milliseconds: number) {
    this.signal = this.controller.signal
    this.expiresAt = Date.now() + milliseconds
    this.timer = setTimeout(() => this.abort(), milliseconds)
    this.timer.unref()
  }

  beginFile(file: string): void {
    this.currentFile = file
    this.lastFile = file
    this.checkpoint()
  }

  endFile(): void {
    this.currentFile = null
  }

  checkpoint(): void {
    if (!this.signal.aborted && Date.now() >= this.expiresAt) this.abort()
    if (this.signal.aborted) throw this.signal.reason
  }

  remainingMilliseconds(): number {
    this.checkpoint()
    return Math.max(1, this.expiresAt - Date.now())
  }

  finish(): void {
    clearTimeout(this.timer)
  }

  private abort(): void {
    const file = this.currentFile ?? this.lastFile ?? '(no transcript opened)'
    this.controller.abort(
      new Error(
        `metric collection deadline of ${this.milliseconds}ms exceeded while reading transcript ${file}`,
      ),
    )
  }
}

async function releaseStream(stream: Readable): Promise<void> {
  if (stream.closed) return
  await new Promise<void>((resolve) => {
    stream.once('close', resolve)
    stream.destroy()
  })
}

export async function readTranscriptLines(
  source: MetricTranscriptSource,
  deadline: MetricCollectionDeadline,
  consume: (line: string) => void,
): Promise<void> {
  deadline.beginFile(source.file)
  const stream = source.open()
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const abort = () => {
    lines.close()
    stream.destroy()
  }
  deadline.signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const line of lines) {
      deadline.checkpoint()
      consume(line)
      deadline.checkpoint()
    }
    deadline.checkpoint()
  } finally {
    deadline.signal.removeEventListener('abort', abort)
    lines.close()
    await releaseStream(stream)
    deadline.endFile()
  }
}
