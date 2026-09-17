import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Info,
  type LucideIcon,
  TriangleAlert,
} from 'lucide-react'
import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { titleCase } from '../text/title-case'

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'progress'

const emphases = {
  subtle: 'border-status-border bg-status-surface text-status-text',
  solid: 'border-transparent bg-status-fill text-status-on-fill',
} as const

/** A neutral tag describes rather than reports, so it carries no icon of its own. */
const toneIcons: Record<Tone, LucideIcon | null> = {
  neutral: null,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  info: Info,
  progress: CircleDashed,
}

type BadgeProps = Omit<HTMLAttributes<HTMLSpanElement>, 'className'> & {
  ref?: Ref<HTMLSpanElement>
  tone?: Tone
  emphasis?: keyof typeof emphases
  /** Replaces the tone's icon; `false` removes it. */
  icon?: LucideIcon | false
  /** A leading dot in the tone's colour, for a state that is live. Replaces the icon. */
  dot?: boolean
  /** The label is an identifier: kept as written and set in mono. */
  identifier?: boolean
  /** Layout only: margin, width and placement. */
  className?: string
  children: ReactNode
}

/**
 * A rounded tag naming one state. The tone selects a status role through
 * `data-tone`, so its surface, border, text and icon come from the same
 * anchor and keep the contrast measured for that role in both themes.
 */
export function Badge({
  tone = 'neutral',
  emphasis = 'subtle',
  icon,
  dot = false,
  identifier = false,
  className,
  children,
  ...props
}: BadgeProps) {
  const Icon = icon === false ? null : (icon ?? toneIcons[tone])
  const label = typeof children === 'string' && !identifier ? titleCase(children) : children
  return (
    <span
      {...props}
      data-tone={tone}
      className={[
        'inline-flex h-5 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium text-xs',
        emphases[emphasis],
        identifier && 'font-mono',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : Icon ? (
        <Icon aria-hidden className="-ml-0.5 size-3 shrink-0" strokeWidth={2} />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  )
}
