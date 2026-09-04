import { Navigate } from 'react-router';
import { GOD_SECTIONS } from '@/utils/godSections';
import { godPath } from '@/utils/paths';

// /god has no page of its own — it opens the first section.
export default function Page() {
  return <Navigate to={godPath(GOD_SECTIONS[0]!.slug)} replace />;
}
