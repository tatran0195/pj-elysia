import { useParams } from 'react-router';
import PublicIssuePage from '@/features/issue/PublicIssuePage';

export default function Page() {
  const { token = '' } = useParams();
  return <PublicIssuePage token={token} />;
}
