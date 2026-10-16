import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { classes } from '../text/classes'

type Renderable = { className?: string; children?: ReactNode }

/**
 * Renders a component's props onto the element a caller supplied, so a Button
 * can be a link. The caller's own props win, except `className`, which joins
 * the component's, and `children`, which the component provides.
 */
export function renderAs<P extends Renderable>(
  render: ReactElement<P> | undefined,
  fallback: ReactElement<P>,
): ReactElement {
  if (!render) return fallback
  const own = fallback.props
  return cloneElement(render, {
    ...own,
    ...render.props,
    className: classes(own.className, render.props.className),
    children: own.children,
  })
}
