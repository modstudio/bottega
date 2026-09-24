import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { classes } from '../text/classes'

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

const cellLook = ({ numeric, nowrap, muted }: CellLook) =>
  classes(
    numeric && 'whitespace-nowrap text-right tabular-nums',
    nowrap && 'whitespace-nowrap',
    muted && 'text-text-muted',
  )

export function Table({
  className,
  ...props
}: Omit<HTMLAttributes<HTMLTableElement>, 'className'> & { className?: string }) {
  return <table {...props} className={classes('w-full border-collapse text-base', className)} />
}

export function TableHeader(props: Omit<HTMLAttributes<HTMLTableSectionElement>, 'className'>) {
  return <thead {...props} className="sticky top-0 z-(--z-sticky) bg-surface-page" />
}

export function TableBody(props: Omit<HTMLAttributes<HTMLTableSectionElement>, 'className'>) {
  return <tbody {...props} className="[&>tr:last-child]:border-b-0" />
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
      className={classes(
        'h-row border-border-subtle border-b',
        selected && 'bg-surface-sunken shadow-[inset_2px_0_0_var(--accent-fill)]',
        nested && 'bg-surface-raised text-text-secondary',
        interactive &&
          'cursor-pointer outline-none hover:bg-control-hover focus-visible:bg-control-hover focus-visible:shadow-[inset_2px_0_0_var(--focus-color)]',
      )}
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
  return (
    <th
      {...props}
      className={classes(
        'h-10 border-border-default border-b px-3 text-left align-middle font-normal text-sm text-text-muted',
        cellLook({ numeric, nowrap, muted }),
        className,
      )}
    />
  )
}

export function TableCell({
  numeric,
  nowrap,
  muted,
  className,
  ...props
}: Omit<TdHTMLAttributes<HTMLTableCellElement>, 'className'> & CellLook) {
  return (
    <td
      {...props}
      className={classes('px-3 py-2 align-middle', cellLook({ numeric, nowrap, muted }), className)}
    />
  )
}
