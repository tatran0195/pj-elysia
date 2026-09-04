import { forwardRef } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';

// The app's link: React Router's `<Link>` under an `href` prop, so every call site
// reads the same as it did before routing moved off Next.
//
// An absolute URL, a `mailto:` and a bare hash are rendered as a plain anchor: they
// leave the app (or move within the document), and there is no client route to
// match them against.

type AnchorProps = Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>;

export interface LinkProps extends AnchorProps {
  href: string;
  /** `false` opts a link out of route preloading; the default preloads on intent. */
  prefetch?: boolean;
  replace?: boolean;
  /**
   * `false` keeps the window scroll where it is across the navigation, for the
   * views that restore their own scroll position (see useHistoryScrollRestoration).
   */
  scroll?: boolean;
  reloadDocument?: boolean;
  viewTransition?: RouterLinkProps['viewTransition'];
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function isExternal(href: string): boolean {
  return EXTERNAL.test(href) || href.startsWith('#');
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, prefetch, scroll, children, ...props },
  ref,
) {
  if (isExternal(href)) {
    return (
      <a ref={ref} href={href} {...props}>
        {children}
      </a>
    );
  }

  return (
    <RouterLink
      ref={ref}
      to={href}
      prefetch={prefetch === false ? 'none' : 'intent'}
      preventScrollReset={scroll === false}
      {...props}
    >
      {children}
    </RouterLink>
  );
});

export default Link;
export { Link };
