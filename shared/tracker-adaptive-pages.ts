import { ToolCallRefused } from './tracker-list-scope.ts'

type PageRead<Row> = {
  pages: Row[][]
  complete: boolean
  pageSize?: number
  nextPageSize: number
  error?: string
}

const smallerPageSize = (pageSize: number) => Math.max(1, Math.floor(pageSize / 2))

const refusal = (
  protocol: 'cursor-mcp' | 'workspace-mcp',
  pageIndex: number,
  rowsRead: number,
  status: string | undefined,
  cause: ToolCallRefused,
) =>
  `${protocol} page index ${pageIndex} after ${rowsRead} rows in status ${status ?? 'all'} was refused at page size 1: ${cause.message}`

const rowBound = (
  project: string,
  protocol: 'cursor-mcp' | 'workspace-mcp',
  status: string | undefined,
  maxRows: number,
) =>
  `${project} ${protocol} status ${status ?? 'all'} reached the row bound of ${maxRows} before the read completed`

export async function readAdaptiveCursorPages<Row>(input: {
  startingPageSize: number
  maxRows: number
  project: string
  status: string | undefined
  read: (
    cursor: string | undefined,
    pageSize: number,
  ) => Promise<{
    rows: Row[]
    nextCursor?: string
  }>
}): Promise<PageRead<Row>> {
  const pages: Row[][] = []
  let pageSize = input.startingPageSize
  let lastSuccessfulPageSize: number | undefined
  let cursor: string | undefined
  let rowsRead = 0
  let positionsRequested = 0
  while (positionsRequested < input.maxRows) {
    const requestedPageSize = Math.min(pageSize, input.maxRows - positionsRequested)
    let reply: { rows: Row[]; nextCursor?: string }
    try {
      reply = await input.read(cursor, requestedPageSize)
    } catch (cause) {
      if (!(cause instanceof ToolCallRefused)) throw cause
      if (pageSize === 1)
        return {
          pages,
          complete: false,
          pageSize: lastSuccessfulPageSize,
          nextPageSize: pageSize,
          error: refusal('cursor-mcp', pages.length, rowsRead, input.status, cause),
        }
      pageSize = smallerPageSize(pageSize)
      continue
    }
    lastSuccessfulPageSize = requestedPageSize
    pages.push(reply.rows)
    rowsRead += reply.rows.length
    positionsRequested += requestedPageSize
    cursor = reply.nextCursor
    if (!cursor) break
  }
  return {
    pages,
    complete: !cursor,
    pageSize: lastSuccessfulPageSize,
    nextPageSize: pageSize,
    ...(cursor
      ? { error: rowBound(input.project, 'cursor-mcp', input.status, input.maxRows) }
      : {}),
  }
}

export async function readAdaptiveWorkspacePages<Row>(input: {
  startingPageSize: number
  maxRows: number
  project: string
  status: string | undefined
  read: (page: number, pageSize: number) => Promise<{ rows: Row[]; lastPage?: number }>
}): Promise<PageRead<Row>> {
  const pages: Row[][] = []
  let pageSize = input.startingPageSize
  let lastSuccessfulPageSize: number | undefined
  let rowOffset = 0
  while (rowOffset < input.maxRows) {
    if (rowOffset + pageSize > input.maxRows)
      return {
        pages,
        complete: false,
        pageSize: lastSuccessfulPageSize,
        nextPageSize: pageSize,
        error: rowBound(input.project, 'workspace-mcp', input.status, input.maxRows),
      }
    const pageIndex = Math.floor(rowOffset / pageSize)
    const pageStart = pageIndex * pageSize
    const page = pageIndex + 1
    let reply: { rows: Row[]; lastPage?: number }
    try {
      reply = await input.read(page, pageSize)
    } catch (cause) {
      if (!(cause instanceof ToolCallRefused)) throw cause
      if (pageSize === 1)
        return {
          pages,
          complete: false,
          pageSize: lastSuccessfulPageSize,
          nextPageSize: pageSize,
          error: refusal('workspace-mcp', pageIndex, rowOffset, input.status, cause),
        }
      pageSize = smallerPageSize(pageSize)
      continue
    }
    lastSuccessfulPageSize = pageSize
    pages.push(reply.rows)
    if (!(reply.lastPage && page < reply.lastPage))
      return { pages, complete: true, pageSize: lastSuccessfulPageSize, nextPageSize: pageSize }
    rowOffset = pageStart + pageSize
  }
  return {
    pages,
    complete: false,
    pageSize: lastSuccessfulPageSize,
    nextPageSize: pageSize,
    error: rowBound(input.project, 'workspace-mcp', input.status, input.maxRows),
  }
}
