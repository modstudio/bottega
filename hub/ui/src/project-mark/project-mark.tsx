import type { CSSProperties } from 'react'
import { projectMarkStyles } from './project-mark.styles.ts'

/**
 * A project's name beside a bar in its register color, the fastest way to tell
 * whose row is whose. The color is set per element through `--project`.
 */
export function ProjectName({
  name,
  color,
  colorDark,
}: {
  name: string
  color?: string | null
  colorDark?: string | null
}) {
  const style = color
    ? ({ '--project-light': color, '--project-dark': colorDark ?? color } as CSSProperties)
    : undefined
  return (
    <span data-project="" style={style} className={projectMarkStyles().root()}>
      <span aria-hidden className={projectMarkStyles().mark()} />
      {name}
    </span>
  )
}
