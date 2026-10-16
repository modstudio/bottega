import { useMutation, useQuery } from '@tanstack/react-query'
import { TRPCClientError } from '@trpc/client'
import { useState } from 'react'
import type { DocAudience, DocScope } from '../../../../shared/docs.ts'
import { queryClient, trpc } from '../client.ts'
import type { DataTreeItem, DocsSource, StoredDocument } from './use-docs.ts'

type DataDoc = DataTreeItem & { body: string; title: string }
export type DataAction<I, O = void> = {
  run: (input: I) => Promise<O | undefined>
  pending: boolean
  error: unknown
  refused?: string
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function useDocsIdentity(enabled: boolean) {
  return useQuery({ ...trpc.record.whoami.queryOptions(), enabled, retry: false })
}

export function useCreateDoc() {
  const mutation = useMutation(trpc.doc.set.mutationOptions())
  return {
    async run(input: Parameters<typeof mutation.mutateAsync>[0]) {
      const row = await mutation.mutateAsync(input)
      await queryClient.invalidateQueries()
      return row
    },
    pending: mutation.isPending,
    error: mutation.error,
  }
}

export function useCreateDocSubjects(enabled: boolean) {
  return useQuery({ ...trpc.doc.subjects.queryOptions(), enabled })
}

export function useArticleSave(
  source: DocsSource,
  doc: DataDoc | null,
  expectedRevision: string | null | undefined,
  isScope: (scope: string) => scope is DocScope,
) {
  const local = useMutation(trpc.doc.set.mutationOptions())
  const hosted = useMutation(trpc.record.saveDoc.mutationOptions())
  const mutation = source === 'hosted' ? hosted : local
  const refused =
    source === 'hosted' && (!doc?.spaceId || !expectedRevision)
      ? 'The current hosted revision is not available.'
      : doc && source === 'local' && !isScope(doc.scope)
        ? 'The document address is not valid.'
        : undefined
  return {
    async run(input: { title: string; body: string; reason: string }) {
      if (!doc || refused) return
      if (source === 'hosted') {
        await hosted.mutateAsync({
          spaceId: doc.spaceId!,
          scope: doc.scope,
          subject: doc.subject,
          slug: doc.slug,
          title: input.title,
          body: input.body,
          reason: input.reason.trim(),
          expectedRevision: expectedRevision!,
        })
      } else {
        await local.mutateAsync({
          scope: doc.scope as DocScope,
          subject: doc.subject,
          slug: doc.slug,
          title: input.title,
          body: input.body,
          reason: input.reason.trim(),
          expectedRevision: expectedRevision ?? undefined,
        })
      }
      await queryClient.invalidateQueries()
    },
    pending: mutation.isPending,
    error: mutation.error,
    refused,
    conflict: mutation.error instanceof TRPCClientError && mutation.error.data?.code === 'CONFLICT',
  }
}

export function useCurrentArticle(
  source: DocsSource,
  doc: DataDoc | null,
  isScope: (scope: string) => scope is DocScope,
) {
  return async () => {
    if (!doc) return null
    if (source === 'hosted') {
      const next = await queryClient.fetchQuery({
        ...trpc.record.doc.queryOptions({ id: doc.id }),
        staleTime: 0,
      })
      return { title: next.title, body: next.body }
    }
    if (!isScope(doc.scope)) return null
    const next = await queryClient.fetchQuery({
      ...trpc.doc.get.queryOptions({ scope: doc.scope, subject: doc.subject, slug: doc.slug }),
      staleTime: 0,
    })
    return { title: next.title, body: next.body }
  }
}

export function useDocDelete(
  source: DocsSource,
  doc: DataDoc | null,
  expectedRevision: string | null | undefined,
  isScope: (scope: string) => scope is DocScope,
) {
  const local = useMutation(trpc.doc.remove.mutationOptions())
  const hosted = useMutation(trpc.record.deleteDoc.mutationOptions())
  const mutation = source === 'hosted' ? hosted : local
  const refused =
    !doc
      ? 'No document is selected.'
      : source === 'hosted' && (!doc.spaceId || !expectedRevision)
      ? 'The current hosted revision is not available.'
      : source === 'local' && !isScope(doc.scope)
        ? 'The document address is not valid.'
        : undefined
  return {
    async run(reason: string) {
      if (refused) return
      if (!doc) return
      if (source === 'hosted') {
        await hosted.mutateAsync({
          id: doc.id,
          spaceId: doc.spaceId!,
          reason: reason.trim(),
          expectedRevision: expectedRevision!,
        })
      } else {
        await local.mutateAsync({
          scope: doc.scope as DocScope,
          subject: doc.subject,
          slug: doc.slug,
          reason: reason.trim(),
          expectedRevision: expectedRevision ?? undefined,
        })
      }
      await queryClient.invalidateQueries()
    },
    pending: mutation.isPending,
    error: mutation.error,
    refused,
  }
}

export function useDocHistory(source: DocsSource, doc: DataDoc | null, audience: DocAudience | null) {
  const local = useQuery({
    ...trpc.doc.history.queryOptions({
      scope: (doc?.scope ?? 'global') as DocScope,
      subject: doc?.subject ?? null,
      slug: doc?.slug ?? '',
    }),
    enabled: source === 'local' && Boolean(doc),
  })
  const hosted = useQuery({
    ...trpc.record.docRevisions.queryOptions({ id: doc?.id ?? '00000000-0000-4000-8000-000000000000', audience: audience ?? undefined }),
    enabled: source === 'hosted' && Boolean(doc),
  })
  const result = source === 'hosted' ? hosted : local
  const items = [
    ...(source === 'hosted' ? (hosted.data?.items ?? []) : (local.data ?? [])),
  ].sort(
    (left, right) =>
      new Date(right.at).getTime() - new Date(left.at).getTime() ||
      String(right.id).localeCompare(String(left.id)),
  )
  return { items, pending: result.isPending, error: result.error }
}

export function useRevisionView(
  source: DocsSource,
  doc: DataDoc | null,
  revisionParam: string | undefined,
  audience: DocAudience | null,
  revisionIdForSource: (source: DocsSource, revision: string | undefined) => number | string | null,
  revisionComparison: (
    ids: readonly (number | string)[],
    id: number | string,
  ) => { kind: 'current' } | { kind: 'revision'; id: number | string } | null,
  revisionViewError: (input: {
    param: string | undefined
    id: number | string | null
    historyIds: readonly (number | string)[] | undefined
    readFailed: boolean
  }) => string | null,
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
      revisionId:
        comparison?.kind === 'revision' && typeof comparison.id === 'number' ? comparison.id : 1,
      audience: audience ?? undefined,
    }),
    enabled: source === 'local' && Boolean(doc && revisionParam && comparison?.kind === 'revision'),
  })
  const hostedItems = hostedHistory.data?.items
  const hostedIds = hostedItems?.map(({ id }) => id)
  const hostedComparison =
    typeof revisionId === 'string' && hostedIds
      ? revisionComparison(hostedIds, revisionId)
      : null
  const hostedSelected = hostedItems?.find(({ id }) => id === revisionId) ?? null
  const hostedNewer =
    hostedComparison?.kind === 'revision'
      ? (hostedItems?.find(({ id }) => id === hostedComparison.id) ?? null)
      : null
  const hostedReplacement =
    hostedSelected?.withheldForAudience || hostedNewer?.withheldForAudience
      ? null
      : hostedComparison?.kind === 'current'
        ? (doc?.body ?? null)
        : (hostedNewer?.body ?? null)
  const localIds = localHistory.data?.map(({ id }) => id)
  const error = revisionViewError({
    param: revisionParam,
    id: revisionId,
    historyIds: source === 'hosted' ? hostedIds : localIds,
    readFailed:
      source === 'hosted'
        ? Boolean(hostedHistory.error)
        : [selected.error, localHistory.error, newer.error].some(Boolean),
  })
  if (source === 'hosted') {
    return { revision: hostedSelected, replacementBody: hostedReplacement, error }
  }
  return {
    revision: selected.data ?? null,
    replacementBody:
      comparison?.kind === 'current'
        ? (doc?.body ?? null)
        : comparison?.kind === 'revision'
          ? (newer.data?.body ?? null)
          : null,
    error,
  }
}

export function useDocSubjects(source: DocsSource, doc: DataDoc | null, enabled: boolean) {
  const project = doc && 'projectName' in doc && typeof doc.projectName === 'string' ? doc.projectName : ''
  const active = enabled && Boolean(project)
  const local = useQuery({
    ...trpc.subject.list.queryOptions({ project }),
    enabled: source === 'local' && active,
  })
  const hosted = useQuery({
    ...trpc.record.subjects.queryOptions({
      spaceId: doc?.spaceId ?? '00000000-0000-4000-8000-000000000000',
      project,
    }),
    enabled: source === 'hosted' && active,
  })
  const query = source === 'hosted' ? hosted : local
  return {
    ready: active && query.isSuccess,
    error: active ? query.error?.message : undefined,
    subjects: (query.data ?? []).map(({ id, name }) => ({ id, name })),
  }
}

export function useDocFieldSave<C>(
  source: DocsSource,
  doc: DataDoc | null,
  stored: StoredDocument | undefined,
  isScope: (scope: string) => scope is DocScope,
  buildInput: (source: Exclude<DocsSource, 'public'>, change: C) => unknown,
) {
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const local = useMutation(trpc.doc.set.mutationOptions())
  const hosted = useMutation(trpc.record.saveDoc.mutationOptions())
  const canAddress = Boolean(doc && (source === 'local' ? isScope(doc.scope) : doc.spaceId))
  const ready = Boolean(stored && (source === 'local' || stored.revision))
  return {
    canAddress,
    disabled: (field: string) => !ready || pending.has(field),
    error: (field: string) => errors[field],
    async run(change: C & { field: string }) {
      if (!canAddress || !stored) return
      const field = change.field
      setErrors((current) => ({ ...current, [field]: undefined }))
      setPending((current) => new Set(current).add(field))
      try {
        const input = buildInput(source === 'hosted' ? 'hosted' : 'local', change)
        if (source === 'hosted')
          await hosted.mutateAsync(input as Parameters<typeof hosted.mutateAsync>[0])
        else await local.mutateAsync(input as Parameters<typeof local.mutateAsync>[0])
        await queryClient.invalidateQueries()
      } catch (error) {
        setErrors((current) => ({ ...current, [field]: message(error) }))
      } finally {
        setPending((current) => {
          const next = new Set(current)
          next.delete(field)
          return next
        })
      }
    },
    pending: local.isPending || hosted.isPending,
    refused: canAddress ? undefined : 'The document address is not valid.',
  }
}
