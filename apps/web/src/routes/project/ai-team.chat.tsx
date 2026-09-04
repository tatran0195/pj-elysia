import { Navigate, useParams } from 'react-router';
import { aiTeamPath } from '@/utils/paths';
import { AI_TEAM_SECTIONS } from '@/utils/settingsSections';

// The chat is a panel now, so its old path has no page of its own and sends the
// viewer to the first AI Team section.
export default function Page() {
  const { projectKey = '' } = useParams();
  return <Navigate to={aiTeamPath(projectKey, AI_TEAM_SECTIONS[0].slug)} replace />;
}
