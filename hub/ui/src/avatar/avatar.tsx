import { avatarStyles } from './avatar.styles.ts'

/** The first letters of up to two words of a name. */
export const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')

/**
 * Who did something, as a mark: a person's initials, or a blank when the record does not say. The name it stands for is its accessible label only when nothing beside it says so.
 */
export function Avatar({
  name,
  labelled = false,
}: {
  name: string | null
  /** Whether to announce the name; leave off when the name is written beside the mark. */
  labelled?: boolean
}) {
  const known = name !== null
  const mark = name ? initials(name) : null
  if (!labelled) {
    return (
      <span className={avatarStyles({ known })} aria-hidden>
        {mark}
      </span>
    )
  }
  return (
    <span className={avatarStyles({ known })} role="img" aria-label={name ?? 'Unknown'}>
      {mark}
    </span>
  )
}
