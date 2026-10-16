import { Button } from '@bottega/hub-ui/button'
import { Callout } from '@bottega/hub-ui/callout'
import { Segmented } from '@bottega/hub-ui/segmented'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Markdown } from '@/components/markdown/markdown'
import { trpc } from '@/trpc/client'
import type { DocScope } from '../../../../shared/docs.ts'
import { hasRecordIdShape } from '../../../../shared/record-id.ts'
import { readingBody } from './body.ts'
import { savedVersionAuthor } from './reading.tsx'
import { revisionComparison, shapeRevisionDiff } from './revision-diff.ts'
import type { DocsAudience, DocsDoc, DocsSource } from './types.ts'

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

export function revisionIdForSource(
  source: DocsSource,
  revisionParam: string | undefined,
): number | string | null {
  if (!revisionParam) return null
  if (source === 'local') return /^\d+$/.test(revisionParam) ? Number(revisionParam) : null
  if (source === 'hosted') return hasRecordIdShape(revisionParam) ? revisionParam : null
  return null
}

function hostedRevisionSelection<
  T extends { id: string; body: string; withheldForAudience: boolean },
>(
  revisions: readonly T[] | undefined,
  revisionId: number | string | null,
  currentBody: string | null,
): { selected: T | null; replacementBody: string | null; ids: string[] | undefined } {
  const ids = revisions?.map(({ id }) => id)
  const comparison =
    typeof revisionId === 'string' && ids ? revisionComparison(ids, revisionId) : null
  const selected = revisions?.find(({ id }) => id === revisionId) ?? null
  const newer =
    comparison?.kind === 'revision'
      ? (revisions?.find(({ id }) => id === comparison.id) ?? null)
      : null
  return {
    selected,
    replacementBody:
      selected?.withheldForAudience || newer?.withheldForAudience
        ? null
        : comparison?.kind === 'current'
          ? currentBody
          : (newer?.body ?? null),
    ids,
  }
}

function revisionReadFailed(
  source: DocsSource,
  hostedError: unknown,
  localErrors: readonly unknown[],
): boolean {
  return source === 'hosted' ? Boolean(hostedError) : localErrors.some(Boolean)
}

function localReplacementBody(
  comparison: ReturnType<typeof revisionComparison> | null,
  currentBody: string | null,
  newerBody: string | undefined,
): string | null {
  if (comparison?.kind === 'current') return currentBody
  return comparison?.kind === 'revision' ? (newerBody ?? null) : null
}

function savedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function useRevisionView(
  source: DocsSource,
  doc: DocsDoc | null,
  revisionParam: string | undefined,
  audience: DocsAudience | null,
) {
  const revisionId = revisionIdForSource(source, revisionParam)
  const address = {
    scope: (doc?.scope ?? 'global') as DocScope,
    subject: doc?.subject ?? null,
    slug: doc?.slug ?? '',
  }
  const localHistory = useQuery({
    ...trpc.doc.history.queryOptions(address),
    enabled: source === 'local' && Boolean(doc && revisionParam),
  })
  const hostedHistory = useQuery({
    ...trpc.record.docRevisions.queryOptions({
      id: doc?.id ?? '00000000-0000-4000-8000-000000000000',
      audience: audience ?? undefined,
    }),
    enabled: source === 'hosted' && Boolean(doc && revisionParam),
  })
  const selected = useQuery({
    ...trpc.doc.revision.queryOptions({
      ...address,
      revisionId: typeof revisionId === 'number' ? revisionId : 1,
      audience: audience ?? undefined,
    }),
    enabled: source === 'local' && Boolean(doc && revisionId),
  })
  const comparison =
    typeof revisionId === 'number'
      ? revisionComparison(
          (localHistory.data ?? []).map(({ id }) => id),
          revisionId,
        )
      : null
  const newer = useQuery({
    ...trpc.doc.revision.queryOptions({
      ...address,
      revisionId: comparison?.kind === 'revision' ? comparison.id : 1,
      audience: audience ?? undefined,
    }),
    enabled: source === 'local' && Boolean(doc && revisionParam && comparison?.kind === 'revision'),
  })
  const hosted = hostedRevisionSelection(hostedHistory.data?.items, revisionId, doc?.body ?? null)
  const localIds = localHistory.data?.map(({ id }) => id)
  const error = revisionViewError({
    param: revisionParam,
    id: revisionId,
    historyIds: source === 'hosted' ? hosted.ids : localIds,
    readFailed: revisionReadFailed(source, hostedHistory.error, [
      selected.error,
      localHistory.error,
      newer.error,
    ]),
  })
  if (source === 'hosted') {
    return { revision: hosted.selected, replacementBody: hosted.replacementBody, error }
  }
  return {
    revision: selected.data ?? null,
    replacementBody: localReplacementBody(comparison, doc?.body ?? null, newer.data?.body),
    error,
  }
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
