import { hostedTrpc, queryClient, trpc } from '@bottega/hub-data/client'
import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { Button } from '@bottega/hub-ui/button'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { Input } from '@bottega/hub-ui/field/input'
import { Textarea } from '@bottega/hub-ui/field/textarea'
import { PageHeader } from '@bottega/hub-ui/page-header'
import {
  type InstructionItem,
  type InstructionReach,
  InstructionsView,
} from '@bottega/hub-views/docs/instructions-view'
import { Markdown } from '@bottega/hub-views/markdown'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

const hosted = isHostedMode()

type CanonRow = {
  slug: string
  title: string
  body: string
  revision: string | null
  updated_at: string
}

const RULES_PREFIX = '.agents/rules/'

/**
 * Where each agent finds a user instruction file. The always-on entry reaches every agent;
 * a rule file reaches only Claude Code, which is the one agent with a rules directory.
 */
function instructionReach(slug: string): InstructionReach[] {
  if (slug === 'AGENTS.md')
    return [
      { agent: 'Claude Code', path: '~/.claude/CLAUDE.md' },
      { agent: 'Codex', path: '~/.codex/AGENTS.md' },
      { agent: 'Grok', path: '~/.grok/AGENTS.md' },
    ]
  if (slug.startsWith(RULES_PREFIX))
    return [{ agent: 'Claude Code', path: `~/.claude/rules/${slug.slice(RULES_PREFIX.length)}` }]
  return []
}

/**
 * A file copied into an agent's home is read at every session start whatever its stored
 * delivery says, so where it lands decides the group it is shown in.
 */
function instructionItem(row: CanonRow): InstructionItem {
  const reach = instructionReach(row.slug)
  return {
    slug: row.slug,
    title: row.title,
    delivery: reach.length ? 'inject' : 'demand',
    updatedAt: row.updated_at,
    reach,
  }
}

/** User canon reads and writes against the server this page is talking to. */
function useUserCanonApi(
  selected: string,
  on: { saved(row: { slug: string }): void; removed(): void },
) {
  const input = { slug: selected || '_' }
  const localDetail = useQuery({
    ...trpc.context.userCanon.get.queryOptions(input),
    enabled: !hosted && Boolean(selected),
  })
  const hostedDetail = useQuery({
    ...hostedTrpc.context.userCanon.get.queryOptions(input),
    enabled: hosted && Boolean(selected),
  })
  const detail = hosted ? hostedDetail : localDetail
  const canonKey = hosted
    ? hostedTrpc.context.userCanon.pathKey()
    : trpc.context.userCanon.pathKey()
  const saved = async (row: { slug: string }) => {
    await queryClient.invalidateQueries({ queryKey: canonKey })
    on.saved(row)
  }
  const removed = async () => {
    on.removed()
    await queryClient.invalidateQueries({ queryKey: canonKey })
  }
  const localSave = useMutation(trpc.context.userCanon.set.mutationOptions({ onSuccess: saved }))
  const hostedSave = useMutation(
    hostedTrpc.context.userCanon.set.mutationOptions({ onSuccess: saved }),
  )
  const save = hosted ? hostedSave : localSave
  const localRemove = useMutation(
    trpc.context.userCanon.remove.mutationOptions({ onSuccess: removed }),
  )
  const hostedRemove = useMutation(
    hostedTrpc.context.userCanon.remove.mutationOptions({ onSuccess: removed }),
  )
  const remove = hosted ? hostedRemove : localRemove
  return { detail, save, remove }
}

function InstructionsEditor({ body, onChange }: { body: string; onChange(value: string): void }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-border border border-border-default">
      <Textarea
        aria-label="Instructions"
        code
        bare
        className="h-[32rem]"
        value={body}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="h-[32rem] overflow-auto p-3">
        <Markdown content={body} />
      </div>
    </div>
  )
}

type Draft = { slug: string; title: string; body: string; reason: string }

const EMPTY_DRAFT: Draft = { slug: '', title: '', body: '', reason: '' }

function EditForm({
  draft,
  onDraft,
  creating,
  save,
  remove,
  onCancel,
}: {
  draft: Draft
  onDraft(draft: Draft): void
  creating: boolean
  save: { run(): void; pending: boolean; error?: string }
  remove: { run(): void; pending: boolean; error?: string }
  onCancel(): void
}) {
  const ready = Boolean(draft.slug.trim() && draft.title.trim() && draft.reason.trim())
  return (
    <div className="space-y-3">
      {creating ? (
        <Input
          aria-label="Name"
          placeholder="Name"
          hint={`AGENTS.md reaches every agent; ${RULES_PREFIX}<name>.md is a Claude Code rule. The name cannot change later.`}
          value={draft.slug}
          onChange={(event) => onDraft({ ...draft, slug: event.target.value })}
        />
      ) : null}
      <Input
        aria-label="Title"
        placeholder="Title"
        value={draft.title}
        onChange={(event) => onDraft({ ...draft, title: event.target.value })}
      />
      <InstructionsEditor body={draft.body} onChange={(body) => onDraft({ ...draft, body })} />
      <Input
        aria-label="Change reason"
        placeholder="Reason (required)"
        hint="Records why these instructions are changing."
        value={draft.reason}
        onChange={(event) => onDraft({ ...draft, reason: event.target.value })}
      />
      {save.error ? <ErrorState title="Could not save" message={save.error} /> : null}
      {remove.error ? <ErrorState title="Could not remove" message={remove.error} /> : null}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!ready || save.pending} onClick={save.run}>
          <Save size={14} /> Save
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          <X size={14} /> Cancel
        </Button>
        {creating ? null : (
          <Button
            variant="danger"
            className="ml-auto"
            disabled={!draft.reason.trim() || remove.pending}
            onClick={remove.run}
          >
            <Trash2 size={14} /> Remove
          </Button>
        )}
      </div>
    </div>
  )
}

export function UserCanonSection({
  rows,
  pending,
  error,
}: {
  rows: CanonRow[] | undefined
  pending: boolean
  error?: string
}) {
  const [choice, setChoice] = useState('')
  const [mode, setMode] = useState<'reading' | 'editing' | 'creating'>('reading')
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const selected = choice || rows?.[0]?.slug || ''
  const { detail, save, remove } = useUserCanonApi(selected, {
    saved: (row) => {
      setChoice(row.slug)
      setMode('reading')
    },
    removed: () => {
      setChoice('')
      setMode('reading')
    },
  })
  const current = detail.data
  useEffect(() => {
    if (mode === 'reading' && current)
      setDraft({ slug: current.slug, title: current.title, body: current.body, reason: '' })
  }, [current, mode])

  const doc =
    mode === 'creating' || !current ? null : { ...instructionItem(current), body: current.body }
  const editing = mode !== 'reading'
  return (
    <InstructionsView
      items={(rows ?? []).map(instructionItem)}
      selectedSlug={mode === 'creating' ? null : selected}
      onSelect={(slug) => {
        setChoice(slug)
        setMode('reading')
      }}
      doc={doc}
      loading={pending || (Boolean(selected) && detail.isPending)}
      error={error ?? detail.error?.message ?? null}
      editing={editing}
      actions={
        editing || !doc ? null : (
          <Button size="sm" variant="secondary" onClick={() => setMode('editing')}>
            <Pencil size={13} /> Edit
          </Button>
        )
      }
      createAction={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDraft(EMPTY_DRAFT)
            setMode('creating')
          }}
        >
          <Plus size={14} /> New instructions
        </Button>
      }
      editor={
        <EditForm
          draft={draft}
          onDraft={setDraft}
          creating={mode === 'creating'}
          onCancel={() => setMode('reading')}
          save={{
            pending: save.isPending,
            error: save.error?.message,
            run: () =>
              save.mutate({
                slug: draft.slug,
                title: draft.title,
                body: draft.body,
                reason: draft.reason,
                expectedRevision:
                  mode === 'creating' ? undefined : (current?.revision ?? undefined),
              }),
          }}
          remove={{
            pending: remove.isPending,
            error: remove.error?.message,
            run: () =>
              remove.mutate({
                slug: draft.slug,
                reason: draft.reason,
                expectedRevision: current?.revision ?? undefined,
              }),
          }}
        />
      }
    />
  )
}

export function PersonalInstructionsPage() {
  const localCanon = useQuery({ ...trpc.context.userCanon.list.queryOptions(), enabled: !hosted })
  const hostedCanon = useQuery({
    ...hostedTrpc.context.userCanon.list.queryOptions(),
    enabled: hosted,
  })
  const canon = hosted ? hostedCanon : localCanon
  return (
    <div className="mx-auto max-w-7xl px-5 pb-12">
      <PageHeader
        title="Instructions"
        subtitle="What every agent you run is told, on every machine you sign in on."
      />
      <UserCanonSection rows={canon.data} pending={canon.isPending} error={canon.error?.message} />
    </div>
  )
}
