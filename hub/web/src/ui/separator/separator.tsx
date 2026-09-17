import { classes } from '../text/classes'

/** A hairline between groups. Decorative unless `label` names what it separates. */
export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical'
  className?: string
}) {
  return (
    <hr
      aria-orientation={orientation}
      className={classes(
        'm-0 shrink-0 border-0 bg-border-default',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-auto w-px self-stretch',
        className,
      )}
    />
  )
}
