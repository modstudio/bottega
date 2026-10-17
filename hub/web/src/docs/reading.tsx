import { DocumentSurface, DocumentTitle } from '@bottega/hub-views/document-surface'
import { KeyLine } from '@bottega/hub-views/key-line'
import { Markdown, MarkdownFenceRenderers } from '@bottega/hub-views/markdown'
import { CalendarDays } from 'lucide-react'
import { type ReactNode, type Ref, type RefObject, useMemo } from 'react'
import { articleListRows } from './article-list.ts'
import { ArticleList } from './article-list.tsx'
import { readingBody, viewedPaneTitle } from './body.ts'
import { CodeSection } from './code-section.tsx'
import { EditableSourceFiles, EditableStatus, type FieldSave } from './doc-field-controls.tsx'
import { DOC_STATUS_LABELS } from './filters.ts'
import type { DocsLocation } from './location.ts'
import { DOC_STATUS_ICONS } from './status-icon.ts'
import type { BreadcrumbPart } from './tree.ts'
import type { DocsAudience, DocsDoc, DocsTreeItem, TreeNode } from './types.ts'

export function savedVersionAuthor(author: string, authorName?: string | null): string {
  const name = authorName?.trim()
  if (name) return name
  const label = author.trim()
  return !label || label === 'unknown' ? 'System' : label
}

/** Whether this reading view is one that shows where an article lives in the code. */
function showsCode(signedIn: boolean, audience: DocsAudience | null): boolean {
  return signedIn && (audience === null || audience === 'technical')
}

/** Whether source paths belong in this reading view. */
export function showSourceFiles(
  signedIn: boolean,
  audience: DocsAudience | null,
  sourceFiles: readonly string[] | undefined,
): boolean {
  return showsCode(signedIn, audience) && Boolean(sourceFiles?.length)
}

function updatedLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

function StatusLine({ status }: { status: DocsDoc['status'] }) {
  const Icon = DOC_STATUS_ICONS[status]
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={14} />
      {DOC_STATUS_LABELS[status]}
    </span>
  )
}

function ReadingAround({
  around,
  onSelect,
}: {
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
}) {
  const { previous, next } = around
  return (
    <div className="doc-measure -mb-8 md:-mb-9 mt-14 flex items-center justify-between gap-4 border-border-default border-t py-5 text-md text-text-muted">
      {previous ? (
        <button
          type="button"
          className="text-left hover:text-text-primary"
          onClick={() => onSelect(previous)}
        >
          ← {previous.title}
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button
          type="button"
          className="text-right hover:text-text-primary"
          onClick={() => onSelect(next)}
        >
          {next.title} →
        </button>
      ) : (
        <span />
      )}
    </div>
  )
}

function DocLifecycle({
  doc,
  replacement,
  locationFor,
  renderLink,
}: {
  doc: DocsDoc
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  renderLink: (location: DocsLocation, children: ReactNode, className?: string) => ReactNode
}) {
  if (doc.status !== 'superseded' || !doc.replacementSlug) return null
  return (
    <span>
      Replaced by{' '}
      {replacement
        ? renderLink(locationFor(replacement), replacement.title, 'text-link hover:underline')
        : doc.replacementSlug}
    </span>
  )
}

function ArticleHeading({
  shown,
  heading,
  titleView,
  editing,
  doc,
  signedIn,
  replacement,
  locationFor,
  field,
  renderLink,
  editBand,
}: {
  shown: { title: string; lede: string | null }
  heading: RefObject<HTMLElement | null>
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  editing?: boolean
  doc: DocsDoc
  signedIn: boolean
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  field?: FieldSave
  renderLink: (location: DocsLocation, children: ReactNode, className?: string) => ReactNode
  editBand?: ReactNode
}) {
  return (
    <>
      {titleView ? (
        titleView(heading)
      ) : (
        <DocumentTitle title={shown.title} ref={heading as Ref<HTMLHeadingElement>} />
      )}
      {editBand ?? (
        <DocKeyInfo
          doc={doc}
          signedIn={signedIn}
          replacement={replacement}
          locationFor={locationFor}
          renderLink={renderLink}
          statusView={field ? <EditableStatus key={doc.id} doc={doc} field={field} /> : undefined}
        />
      )}
      {shown.lede && !editing ? (
        <p className="doc-measure mt-3.5 text-lg text-text-muted">{shown.lede}</p>
      ) : null}
    </>
  )
}

function DocKeyInfo({
  doc,
  signedIn,
  replacement,
  locationFor,
  renderLink,
  statusView,
}: {
  doc: DocsDoc
  signedIn: boolean
  statusView?: ReactNode
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  renderLink: (location: DocsLocation, children: ReactNode, className?: string) => ReactNode
}) {
  return (
    <KeyLine
      items={[
        ...(signedIn
          ? [{ key: 'status', content: statusView ?? <StatusLine status={doc.status} /> }]
          : []),
        {
          key: 'updated',
          icon: <CalendarDays size={14} />,
          content: <>Updated {updatedLabel(doc.updatedAt)}</>,
        },
        ...(signedIn
          ? [
              {
                key: 'lifecycle',
                content: (
                  <DocLifecycle
                    doc={doc}
                    replacement={replacement}
                    locationFor={locationFor}
                    renderLink={renderLink}
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  )
}

export function DocsReading({
  doc,
  crumbs,
  around,
  onSelect,
  replacement,
  locationFor,
  headerAction,
  error,
  pending,
  wide,
  onWide,
  signedIn,
  audience,
  tree,
  bodyView,
  viewedRevision,
  editing,
  editBand,
  banner,
  titleView,
  field,
  renderLink,
}: {
  doc: DocsDoc | null
  wide: boolean
  onWide: (wide: boolean) => void
  signedIn: boolean
  audience: DocsAudience | null
  tree: readonly TreeNode[]
  bodyView?: ReactNode
  viewedRevision?: { title: string; body: string } | null
  /** A document is chosen and on its way, so the pane stays quiet rather than saying there is none. */
  pending: boolean
  crumbs: readonly BreadcrumbPart[]
  around: { previous: DocsTreeItem | null; next: DocsTreeItem | null }
  onSelect: (item: DocsTreeItem) => void
  replacement: DocsTreeItem | null
  locationFor: (item: DocsTreeItem) => DocsLocation
  headerAction?: ReactNode
  error?: string | null
  editing?: boolean
  /** While editing, the tools that take the place of the status line under the title. */
  editBand?: ReactNode
  banner?: ReactNode
  titleView?: (headingRef: Ref<HTMLElement | null>) => ReactNode
  /** Where the article's fields are saved, set only when this reader may edit them in place. */
  field?: FieldSave
  renderLink: (location: DocsLocation, children: ReactNode, className?: string) => ReactNode
}) {
  const shown = doc ? viewedPaneTitle(doc, viewedRevision ?? null) : { title: '', lede: null }
  const rows = useMemo(() => (doc ? articleListRows(tree, doc.id) : []), [tree, doc])
  const fenceRenderers = useMemo(
    () => ({
      articleList: () => (
        <ArticleList rows={rows} locationFor={locationFor} renderLink={renderLink} />
      ),
    }),
    [rows, locationFor, renderLink],
  )
  return (
    <MarkdownFenceRenderers.Provider value={fenceRenderers}>
      {doc ? (
        <DocumentSurface
          crumbs={[...crumbs]}
          title={shown.title}
          heading={(heading) => (
            <ArticleHeading
              shown={shown}
              heading={heading as RefObject<HTMLElement | null>}
              titleView={titleView}
              editing={editing}
              doc={doc}
              signedIn={signedIn}
              replacement={replacement}
              locationFor={locationFor}
              field={field}
              renderLink={renderLink}
              editBand={editBand}
            />
          )}
          headerActions={headerAction}
          wide={wide}
          onWideChange={onWide}
          banner={banner}
          error={error}
          body={
            <>
              {bodyView ?? (
                <div className="mt-6">
                  <Markdown content={readingBody(doc.body)} />
                </div>
              )}
              {field && doc.kind === 'article' && showsCode(signedIn, audience) ? (
                <EditableSourceFiles key={doc.id} doc={doc} field={field} />
              ) : showSourceFiles(signedIn, audience, doc.sourceFiles) ? (
                <CodeSection key={doc.id} count={doc.sourceFiles?.length ?? 0}>
                  <ul>
                    {doc.sourceFiles?.map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                </CodeSection>
              ) : null}
            </>
          }
          footer={<ReadingAround around={around} onSelect={onSelect} />}
        />
      ) : (
        <DocumentSurface
          crumbs={[]}
          title=""
          heading={() => null}
          body={<p className="text-md text-text-muted">No document to show.</p>}
          pending={pending}
          error={error}
        />
      )}
    </MarkdownFenceRenderers.Provider>
  )
}
