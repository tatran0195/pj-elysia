import { Outlet } from 'react-router';
import Shell from '@/components/layout/Shell';
import { readCookie } from '@/utils/cookies';

// The project layout owns the planner Shell (sidebar, header, overlays, project
// data) and renders the active child route inside it. The sidebar open/collapsed
// state is persisted in the `sidebar_state` cookie by SidebarProvider; read it here
// so the sidebar renders in its last state on first paint (no flicker).
export default function ProjectLayout() {
  const defaultSidebarOpen = readCookie('sidebar_state') !== 'false';
  return (
    <Shell defaultSidebarOpen={defaultSidebarOpen}>
      <Outlet />
    </Shell>
  );
}
