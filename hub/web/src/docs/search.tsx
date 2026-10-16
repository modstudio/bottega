import { Dialog } from '@bottega/hub-ui/dialog'
import { Input } from '@bottega/hub-ui/field/input'
import { Kbd } from '@bottega/hub-ui/kbd'
import { moveIndex } from '@bottega/hub-ui/state/list-navigation'
import { classes } from '@bottega/hub-ui/text/classes'
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { highlightSnippet } from './map.ts'
import { DocStatusBadge } from './status-badge.tsx'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

function SearchSnippet({ match }: { match: DocsSearchMatch }) {
  return (
    <p className="mt-0.5 text-sm text-text-muted leading-5">
      {highlightSnippet(match).map((part) =>
        part.highlight ? (
          <mark key={part.start} className="bg-surface-sunken text-text-primary">
            {part.text}
          </mark>
        ) : (
          <Fragment key={part.start}>{part.text}</Fragment>
        ),
      )}
    </p>
  )
}

function SearchResultRow({
  match,
  selected,
  onHover,
  onChoose,
}: {
  match: DocsSearchMatch
  selected: boolean
  onHover: () => void
  onChoose: () => void
}) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the search input; arrow keys move aria-selected
    <div
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onPointerDown={(event) => event.preventDefault()}
      onPointerUp={onChoose}
      className={classes('cursor-pointer rounded-sm px-2.5 py-2', selected && 'bg-control-hover')}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-md text-text-primary">{match.title}</span>
        <DocStatusBadge status={match.status} />
        {match.spaceName ? (
          <span className="text-text-muted text-xs">{match.spaceName}</span>
        ) : null}
      </div>
      {match.snippet ? <SearchSnippet match={match} /> : null}
    </div>
  )
}

export function SearchDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  results,
  tree,
  onChoose,
  scopeLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  results: readonly DocsSearchMatch[]
  tree: readonly DocsTreeItem[]
  onChoose: (item: DocsTreeItem) => void
  scopeLabel: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [active, setActive] = useState(0)
  const byId = new Map(tree.map((item) => [item.id, item]))
  const bySlug = new Map(tree.map((item) => [item.slug, item]))

  useEffect(() => {
    if (!open) return
    setActive(0)
    input.current?.focus()
  }, [open])

  const choose = (match: DocsSearchMatch) => {
    const item = byId.get(match.id) ?? bySlug.get(match.slug)
    if (!item) return
    onChoose(item)
    onOpenChange(false)
  }

  const onListKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
    if (!results.length) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const match = results[active]
      if (match) choose(match)
      return
    }
    const next = moveIndex(
      event.key,
      active,
      results.map(() => false),
    )
    if (next !== active) {
      event.preventDefault()
      setActive(next)
    }
  }

  const needle = query.trim()
  const hint =
    needle.length < 2
      ? 'Type at least two letters. Try "worktree" or "score".'
      : `Nothing matches "${needle}".`

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search docs"
      variant="chromeless"
      size="lg"
      className="top-[12vh] max-h-[min(35rem,80vh)]"
    >
      <div className="flex items-center gap-2.5 border-border-default border-b px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <Input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => {
              setActive(0)
              onQueryChange(event.target.value)
            }}
            onKeyDown={onListKey}
            placeholder="Search titles and text"
            aria-label="Search titles and text"
            aria-controls={listId}
            autoComplete="off"
          />
        </div>
        <Kbd>Esc</Kbd>
      </div>
      <div className="max-h-[min(25rem,56vh)] overflow-auto px-1.5 py-2">
        {results.length === 0 ? (
          <p className="mx-2.5 my-3.5 text-md text-text-muted">{hint}</p>
        ) : (
          <div id={listId} role="listbox">
            {results.map((match, index) => (
              <SearchResultRow
                key={`${match.id}:${match.slug}`}
                match={match}
                selected={index === active}
                onHover={() => setActive(index)}
                onChoose={() => choose(match)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-border-default border-t px-3.5 py-2 text-text-muted text-xs">
        <span>
          <Kbd>↑</Kbd>
          <Kbd className="ml-1">↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span className="ml-auto">{scopeLabel}</span>
      </div>
    </Dialog>
  )
}
