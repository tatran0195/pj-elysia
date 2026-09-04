import { Navigate, useParams } from 'react-router';
import RequireFeature from '@/components/common/permissions/RequireFeature';
import CyclesPage from '@/features/cycles/CyclesPage';
import { cyclesPath, isCyclesView } from '@/utils/paths';

// One layout of the cycles list: the grouped table or the day track.
export default function Page() {
  const { projectKey = '', view = '' } = useParams();
  if (!isCyclesView(view)) return <Navigate to={cyclesPath(projectKey)} replace />;

  return (
    <RequireFeature feature="cycles">
      <CyclesPage view={view} />
    </RequireFeature>
  );
}
