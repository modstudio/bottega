import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { tableCellStyles, tableHeadStyles, tableRowStyles, tableStyles } from './table.styles.ts'

type CellLook = {
  /** Right-aligned figures in tabular numerals, never wrapped. */
  numeric?: boolean
  /** Keep the content on one line. */
  nowrap?: boolean
  /** Secondary information in the muted text color. */
  muted?: boolean
  /** Layout only: width and placement. */
  className?: string
}

export function Table({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLTableElement>, 'className'> & { className?: string }) {
  return <table {...props} className={tableStyles().table({ class: className })} />
}

export function TableHeader(props: Omit<HTMLAttributes<HTMLTableSectionElement>, 'className'>) {
  return <thead {...props} className={tableStyles().header()} />
}

export function TableBody(props: Omit<HTMLAttributes<HTMLTableSectionElement>, 'className'>) {
  return <tbody {...props} className={tableStyles().body()} />
}

export function TableRow({
  nested = false,
  interactive = false,
  selected = false,
  ...props
}: Omit<HTMLAttributes<HTMLTableRowElement>, 'className'> & {
  /** A row belonging to the record above it. */
  nested?: boolean
  /** The whole row opens its record. */
  interactive?: boolean
  /** Its record is open beside the table. */
  selected?: boolean
}) {
  return (
    <tr
      {...props}
      aria-current={selected || undefined}
      className={tableRowStyles({ selected, nested, interactive })}
    />
  )
}

export function TableHead({
  numeric,
  nowrap = true,
  muted,
  className,
  ...props
}: Omit<ThHTMLAttributes<HTMLTableCellElement>, 'className'> & CellLook) {
  return <th {...props} className={tableHeadStyles({ numeric, nowrap, muted, class: className })} />
}

export function TableCell({
  numeric,
  nowrap,
  muted,
  className,
  ...props
}: Omit<TdHTMLAttributes<HTMLTableCellElement>, 'className'> & CellLook) {
  return <td {...props} className={tableCellStyles({ numeric, nowrap, muted, class: className })} />
}
