import type { CSSProperties } from 'react'

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
    <span
      data-project=""
      style={style}
      className="inline-flex items-center gap-2 whitespace-nowrap font-medium"
    >
      <span aria-hidden className="h-3.5 w-[3px] shrink-0 bg-project" />
      {name}
    </span>
  )
}
