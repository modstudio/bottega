import { type ComponentType, createContext, type ReactNode, useContext } from 'react'

export type SiteLinkProps = {
  to: string
  className?: string
  children: ReactNode
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
  'aria-label'?: string
}

type SiteNavigationValue = {
  Link: ComponentType<SiteLinkProps>
  currentPath: string
}

const SiteNavigationContext = createContext<SiteNavigationValue | null>(null)

export function SiteNavigation({
  link,
  currentPath,
  children,
}: {
  link: ComponentType<SiteLinkProps>
  currentPath: string
  children: ReactNode
}) {
  return (
    <SiteNavigationContext value={{ Link: link, currentPath }}>{children}</SiteNavigationContext>
  )
}

export function useSiteNavigation() {
  const navigation = useContext(SiteNavigationContext)
  if (!navigation) throw new Error('SiteNavigation must wrap the public site')
  return navigation
}

export function SiteLink(props: SiteLinkProps) {
  const { Link } = useSiteNavigation()
  return <Link {...props} />
}
