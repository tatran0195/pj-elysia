import { index, layout, prefix, route, type RouteConfig } from '@react-router/dev/routes';

// The route table, in the shape the URLs already had. Two layout routes carry the
// chrome — the planner Shell for everything under /project/:projectKey, and the
// instance-wide GodShell for /god — so a navigation inside either keeps the sidebar
// mounted. The share pages sit under their own layout, which marks them noindex.
export default [
  index('routes/home.tsx'),

  route('login', 'routes/login.tsx'),
  route('register', 'routes/register.tsx'),
  route('forgot-password', 'routes/forgot-password.tsx'),
  route('reset-password', 'routes/reset-password.tsx'),

  ...prefix('account', [
    route('accounts', 'routes/account/accounts.tsx'),
    route('api-keys', 'routes/account/api-keys.tsx'),
    route('preferences', 'routes/account/preferences.tsx'),
    route('profile', 'routes/account/profile.tsx'),
    route('projects', 'routes/account/projects.tsx'),
    route('security', 'routes/account/security.tsx'),
  ]),

  route('invite/:token', 'routes/invite.$token.tsx'),
  route('issue/:issueId', 'routes/issue.$issueId.tsx'),

  layout('routes/god/layout.tsx', [
    ...prefix('god', [
      index('routes/god/index.tsx'),
      route('auth-provider', 'routes/god/auth-provider.tsx'),
      route('authentication', 'routes/god/authentication.tsx'),
      route('email', 'routes/god/email.tsx'),
      route('general', 'routes/god/general.tsx'),
      route('hotkeys', 'routes/god/hotkeys.tsx'),
      route('projects', 'routes/god/projects.tsx'),
      route('scim', 'routes/god/scim.tsx'),
      route('storage', 'routes/god/storage.tsx'),
      route('telegram', 'routes/god/telegram.tsx'),
      route('users', 'routes/god/users.tsx'),
    ]),
  ]),

  layout('routes/project/layout.tsx', [
    ...prefix('project/:projectKey', [
      index('routes/project/index.tsx'),
      route('agent-skills', 'routes/project/agent-skills.tsx'),
      route('agent-tools', 'routes/project/agent-tools.tsx'),
      route('ai-agents', 'routes/project/ai-agents.tsx'),
      route('ai-team/chat', 'routes/project/ai-team.chat.tsx'),
      route('ai-team/schedules', 'routes/project/ai-team.schedules.tsx'),
      route('api', 'routes/project/api.tsx'),
      route('cycles', 'routes/project/cycles.index.tsx'),
      route('cycles/details/:cycleId', 'routes/project/cycles.details.$cycleId.tsx'),
      route('cycles/:view', 'routes/project/cycles.$view.tsx'),
      route('dashboard', 'routes/project/dashboard.index.tsx'),
      route('dashboard/:dashboardId', 'routes/project/dashboard.$dashboardId.tsx'),
      route('inbox', 'routes/project/inbox.tsx'),
      route('initiatives', 'routes/project/initiatives.index.tsx'),
      route(
        'initiatives/details/:initiativeId',
        'routes/project/initiatives.details.$initiativeId.tsx',
      ),
      route(
        'initiatives/details/:initiativeId/issues',
        'routes/project/initiatives.details.$initiativeId.issues.tsx',
      ),
      route('initiatives/:tab', 'routes/project/initiatives.$tab.tsx'),
      route('integrations', 'routes/project/integrations.tsx'),
      route('issue/:issueId', 'routes/project/issue.$issueId.tsx'),
      route('mcp', 'routes/project/mcp.tsx'),
      route('members', 'routes/project/members.index.tsx'),
      route('members/roles', 'routes/project/members.roles.tsx'),
      route('notes', 'routes/project/notes.index.tsx'),
      route('notes/:boardId', 'routes/project/notes.$boardId.tsx'),
      route('notifications', 'routes/project/notifications.tsx'),
      route('settings/actions', 'routes/project/settings.actions.tsx'),
      route('settings/configuration', 'routes/project/settings.configuration.tsx'),
      route('settings/custom-fields', 'routes/project/settings.custom-fields.tsx'),
      route('settings/general', 'routes/project/settings.general.tsx'),
      route('settings/git', 'routes/project/settings.git.tsx'),
      route('settings/issue-types', 'routes/project/settings.issue-types.tsx'),
      route('settings/labels', 'routes/project/settings.labels.tsx'),
      route('settings/notifications', 'routes/project/settings.notifications.tsx'),
      route('settings/states', 'routes/project/settings.states.tsx'),
      route('settings/webhooks', 'routes/project/settings.webhooks.tsx'),
      route('view/:viewId', 'routes/project/view.$viewId.tsx'),
    ]),
  ]),

  layout('routes/share/layout.tsx', [
    ...prefix('share', [
      route('issue/:token', 'routes/share/issue.$token.tsx'),
      route('view/:token', 'routes/share/view.$token.tsx'),
    ]),
  ]),

  // The short link for an issue, e.g. /IAP-62. Last, so every static route above
  // wins over it and only otherwise-unmatched single segments reach it.
  route(':identifier', 'routes/identifier.tsx'),

  // Anything else: a real page instead of the root ErrorBoundary, so a 404 does not
  // fight the prerendered shell during hydration.
  route('*', 'routes/not-found.tsx'),
] satisfies RouteConfig;
