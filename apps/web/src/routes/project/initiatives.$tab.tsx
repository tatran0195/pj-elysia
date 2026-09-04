import { Navigate, useParams } from 'react-router';
import RequireFeature from '@/components/common/permissions/RequireFeature';
import InitiativesPage from '@/features/initiatives/InitiativesPage';
import { initiativesPath, isInitiativesTab } from '@/utils/paths';

// One status tab of the initiatives list, "All" included.
export default function Page() {
  const { projectKey = '', tab = '' } = useParams();
  if (!isInitiativesTab(tab)) return <Navigate to={initiativesPath(projectKey)} replace />;

  return (
    <RequireFeature feature="initiatives">
      <InitiativesPage tab={tab} />
    </RequireFeature>
  );
}
