import { Dialog } from '@bottega/hub-ui/dialog'
import { Input } from '@bottega/hub-ui/field/input'
import { Kbd } from '@bottega/hub-ui/kbd'
import { moveIndex } from '@bottega/hub-ui/state/list-navigation'
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { highlightSnippet } from './map.ts'
import { searchStyles } from './search.styles.ts'
import { DocStatusBadge } from './status-badge.tsx'
import type { DocsSearchMatch, DocsTreeItem } from './types.ts'

function SearchSnippet({ match }: { match: DocsSearchMatch }) {
  return (
    <p className={searchStyles().snippet()}>
      {highlightSnippet(match).map((part) =>
        part.highlight ? (
          <mark key={part.start} className={searchStyles().highlight()}>
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
      className={searchStyles().result({ selected })}
    >
      <div className={searchStyles().resultHeading()}>
        <span className={searchStyles().resultTitle()}>{match.title}</span>
        <DocStatusBadge status={match.status} />
        {match.spaceName ? (
          <span className={searchStyles().resultSpace()}>{match.spaceName}</span>
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
      className={searchStyles().dialog()}
    >
      <div className={searchStyles().searchHeader()}>
        <div className={searchStyles().searchField()}>
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
            aria-controls={results.length ? listId : undefined}
            autoComplete="off"
          />
        </div>
        <Kbd>Esc</Kbd>
      </div>
      <div className={searchStyles().results()}>
        {results.length === 0 ? (
          <p className={searchStyles().hint()}>{hint}</p>
        ) : (
          <div id={listId} role="listbox" aria-label="Search results">
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
      <div className={searchStyles().footer()}>
        <span>
          <Kbd>↑</Kbd>
          <Kbd className={searchStyles().shortcutKey()}>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span className={searchStyles().scopeLabel()}>{scopeLabel}</span>
      </div>
    </Dialog>
  )
}
