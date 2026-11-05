import { EmptyState } from '@bottega/hub-ui/empty-state'
import { ErrorState } from '@bottega/hub-ui/error-state'
import { InfoTip } from '@bottega/hub-ui/popover/info-tip'
import { BookOpen, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { DocumentSurface, DocumentTitle } from '../document-surface/document-surface.tsx'
import { KeyLine } from '../key-line/key-line.tsx'
import { Markdown } from '../markdown/markdown.tsx'
import { readingBody } from './body.ts'
import { instructionsViewStyles } from './instructions-view.styles.ts'
import type { DocsDelivery } from './types.ts'

type InstructionDelivery = DocsDelivery | 'path'

/** One agent that reads an instruction file, and where that agent finds it. */
export type InstructionReach = { agent: string; path: string; paths?: readonly string[] }

export type InstructionItem = {
  slug: string
  title: string
  delivery: InstructionDelivery
  updatedAt: string
  reach: readonly InstructionReach[]
}

export type InstructionDocument = InstructionItem & { body: string }

const GROUPS: { delivery: InstructionDelivery; heading: string; hint: string; empty: string }[] = [
  {
    delivery: 'inject',
    heading: 'Always on',
    hint: 'Every agent reads these at the start of every session.',
    empty: 'Nothing is always on yet.',
  },
  {
    delivery: 'path',
    heading: 'Path-scoped',
    hint: 'An agent reads these when it works on matching files.',
    empty: 'Nothing is path-scoped yet.',
  },
  {
    delivery: 'demand',
    heading: 'On demand',
    hint: 'References an agent opens when the work calls for them.',
    empty: 'No references yet.',
  },
]

const MANAGED_MARKER = /^<!--[^\n]*-->\n?/

/**
 * The body as a reader sees it: without the comment that marks a generated file, and without
 * the opening heading the page title already shows.
 */
function readableInstructions(body: string): string {
  return readingBody(body.replace(MANAGED_MARKER, '').trimStart())
}

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function InstructionsRail({
  items,
  selectedSlug,
  onSelect,
  createAction,
}: {
  items: readonly InstructionItem[]
  selectedSlug: string | null
  onSelect: (slug: string) => void
  createAction?: ReactNode
}) {
  return (
    <nav className={instructionsViewStyles().rail()} aria-label="Your instructions">
      {GROUPS.map((group) => {
        const rows = items.filter((item) => item.delivery === group.delivery)
        return (
          <section key={group.delivery} className={instructionsViewStyles().group()}>
            <h2 className={instructionsViewStyles().groupHeading()}>
              {group.heading}
              <InfoTip label={`About ${group.heading}`}>{group.hint}</InfoTip>
            </h2>
            {rows.length === 0 ? (
              <p className={instructionsViewStyles().empty()}>{group.empty}</p>
            ) : null}
            {rows.map((item) => (
              <button
                key={item.slug}
                type="button"
                aria-current={item.slug === selectedSlug ? 'page' : undefined}
                className={instructionsViewStyles({ current: item.slug === selectedSlug }).row()}
                onClick={() => onSelect(item.slug)}
              >
                <span className={instructionsViewStyles().rowTitle()}>{item.title}</span>
                <span className={instructionsViewStyles().rowMeta()}>{item.slug}</span>
              </button>
            ))}
          </section>
        )
      })}
      {createAction}
    </nav>
  )
}

function reachLine(doc: InstructionDocument) {
  const delivery =
    doc.delivery === 'inject'
      ? { key: 'delivery', icon: <Zap size={14} />, content: 'Always on' }
      : {
          key: 'delivery',
          icon: <BookOpen size={14} />,
          content: doc.delivery === 'path' ? 'Path-scoped' : 'On demand',
        }
  const reach = doc.reach.length
    ? doc.reach.map((target) => ({
        key: `reach-${target.agent}`,
        content: (
          <span className={instructionsViewStyles().reach()}>
            <span className={instructionsViewStyles().reachAgent()}>{target.agent}</span>
            <span className={instructionsViewStyles().reachPath()}>
              {target.path}
              {target.paths?.length ? ` · ${target.paths.join(', ')}` : ''}
            </span>
          </span>
        ),
      }))
    : [{ key: 'reach-none', content: 'Read through the doc store, not copied to any agent' }]
  return [delivery, ...reach, { key: 'updated', content: `Updated ${updatedLabel(doc.updatedAt)}` }]
}

export function InstructionsView({
  items,
  selectedSlug,
  onSelect,
  doc,
  editing = false,
  editor,
  actions,
  createAction,
  loading,
  error,
}: {
  items: readonly InstructionItem[]
  selectedSlug: string | null
  onSelect: (slug: string) => void
  doc: InstructionDocument | null
  editing?: boolean
  /** Takes the place of the reading body while the document is being edited. */
  editor?: ReactNode
  actions?: ReactNode
  createAction?: ReactNode
  loading: boolean
  error?: string | null
}) {
  const title = doc?.title ?? 'New instructions'
  return (
    <div className={instructionsViewStyles().root()}>
      <InstructionsRail
        items={items}
        selectedSlug={selectedSlug}
        onSelect={onSelect}
        createAction={createAction}
      />
      {doc || editing ? (
        <DocumentSurface
          crumbs={[
            { key: 'settings', label: 'Settings' },
            { key: 'instructions', label: 'Instructions' },
          ]}
          title={title}
          heading={(ref) => <DocumentTitle ref={ref} title={title} />}
          keyLine={doc ? <KeyLine items={reachLine(doc)} /> : undefined}
          headerActions={actions}
          error={error}
          errorSubject="your instructions"
          body={
            editing ? (
              <div className={instructionsViewStyles().editor()}>{editor}</div>
            ) : (
              <div className={instructionsViewStyles().body()}>
                <Markdown content={readableInstructions(doc?.body ?? '')} />
              </div>
            )
          }
        />
      ) : error ? (
        <ErrorState title="Could not load your instructions" message={error} />
      ) : (
        <EmptyState
          title={loading ? 'Loading your instructions...' : 'Choose a set of instructions.'}
        />
      )}
    </div>
  )
}
