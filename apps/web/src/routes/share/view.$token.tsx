import { useParams } from 'react-router';
import PublicBoardPage from '@/features/work-items/PublicBoardPage';

export default function Page() {
  const { token = '' } = useParams();
  return <PublicBoardPage token={token} />;
}
