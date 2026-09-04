import { useParams } from 'react-router';
import RequireFeature from '@/components/common/permissions/RequireFeature';
import CycleDetailPage from '@/features/cycles/CycleDetailPage';
import NotFound from '@/components/common/NotFound';

export default function Page() {
  const { cycleId = '' } = useParams();
  const id = Number(cycleId);
  if (!Number.isInteger(id)) return <NotFound />;

  return (
    <RequireFeature feature="cycles">
      <CycleDetailPage cycleId={id} />
    </RequireFeature>
  );
}
