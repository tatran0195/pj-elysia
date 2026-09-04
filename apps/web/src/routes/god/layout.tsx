import { Outlet } from 'react-router';
import GodShell from '@/components/layout/GodShell';
import { readCookie } from '@/utils/cookies';

// God mode lives outside the project shell: its settings are instance-wide, so no
// project is loaded. The sidebar open/collapsed state uses the same `sidebar_state`
// cookie as the project layout, so the sidebar keeps its width across the two.
export default function GodLayout() {
  const defaultSidebarOpen = readCookie('sidebar_state') !== 'false';
  return (
    <GodShell defaultSidebarOpen={defaultSidebarOpen}>
      <Outlet />
    </GodShell>
  );
}
