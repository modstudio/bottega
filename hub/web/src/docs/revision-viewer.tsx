import { Button } from '@bottega/hub-ui/button'
import { Callout } from '@bottega/hub-ui/callout'
import { Segmented } from '@bottega/hub-ui/segmented'
import { Markdown } from '@bottega/hub-views/markdown'
import { useMemo } from 'react'
import { readingBody } from './body.ts'
import { savedVersionAuthor } from './reading.tsx'
import { shapeRevisionDiff } from './revision-diff.ts'

export type RevisionMode = 'diff' | 'version'

export function revisionViewError(input: {
  param: string | undefined
  id: number | string | null
  historyIds: readonly (number | string)[] | undefined
  readFailed: boolean
}): string | null {
  if (!input.param) return null
  if (
    input.id === null ||
    input.readFailed ||
    (input.historyIds !== undefined && !input.historyIds.includes(input.id))
  )
    return `Revision ${input.param} could not be read.`
  return null
}

function savedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function RevisionViewer({
  revision,
  replacementBody,
  onCurrent,
  mode,
  onMode,
}: {
  revision: {
    body: string
    author: string
    authorName?: string | null
    at: string
    withheldForAudience?: boolean
  }
  replacementBody: string | null
  onCurrent: () => void
  mode: RevisionMode
  onMode: (mode: RevisionMode) => void
}) {
  const diffOffered = !revision.withheldForAudience && replacementBody !== null
  const diff = useMemo(
    () => (replacementBody === null ? null : shapeRevisionDiff(revision.body, replacementBody)),
    [revision.body, replacementBody],
  )
  const author = savedVersionAuthor(revision.author, revision.authorName)
  return (
    <div className="mt-6">
      <Callout
        tone="warning"
        title={`Viewing a version saved by ${author} on ${savedAt(revision.at)}`}
      >
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {diffOffered ? (
            <Segmented
              label="Version display"
              value={mode}
              options={[
                { value: 'diff', label: 'Show diff' },
                { value: 'version', label: 'Show version' },
              ]}
              onChange={(value) => onMode(value as RevisionMode)}
            />
          ) : null}
          <Button size="sm" variant="secondary" onClick={onCurrent}>
            Back to current
          </Button>
        </div>
      </Callout>
      {revision.withheldForAudience ? (
        <p className="mt-6 text-md text-text-muted">
          This version was not available to the selected audience.
        </p>
      ) : mode === 'version' || !diffOffered ? (
        <div className="mt-6">
          <Markdown content={readingBody(revision.body)} />
        </div>
      ) : diff?.identical ? (
        <p className="mt-6 text-md text-text-muted">
          This version is identical to the one that replaced it.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto border border-border-default font-mono text-sm">
          {diff?.hunks.map((hunk) => (
            <div
              key={`${hunk[0]?.number}-${hunk.at(-1)?.number}-${hunk[0]?.kind}`}
              className="border-border-default border-t first:border-t-0"
            >
              {hunk.map((line) => (
                <div
                  key={`${line.number}-${line.kind}`}
                  data-tone={
                    line.kind === 'context'
                      ? undefined
                      : line.kind === 'added'
                        ? 'success'
                        : 'error'
                  }
                  className="grid grid-cols-[3.5rem_1.5rem_minmax(max-content,1fr)] bg-status-surface"
                >
                  <span className="border-border-default border-r px-2 py-0.5 text-right text-text-muted tabular-nums">
                    {line.number}
                  </span>
                  <span className="px-1.5 py-0.5 text-status-text">
                    {line.mark}
                    {line.kind === 'added' ? <span className="sr-only">Added:</span> : null}
                    {line.kind === 'removed' ? <span className="sr-only">Removed:</span> : null}
                  </span>
                  <span className="whitespace-pre px-1.5 py-0.5 text-text-primary">
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
