import { separatorStyles } from './separator.styles.ts'

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
      className={separatorStyles({ orientation, class: className })}
    />
  )
}
