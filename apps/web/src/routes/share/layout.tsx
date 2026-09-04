import { Outlet } from 'react-router';
import type { Route } from './+types/layout';

// Public read-only share pages. Never indexed: the token is unguessable but a
// shared page must not surface in search engines or be followed by crawlers.
export const meta: Route.MetaFunction = () => [
  { name: 'robots', content: 'noindex, nofollow, noarchive' },
];

export default function ShareLayout() {
  return <Outlet />;
}
