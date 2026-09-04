import { groupDisplayNames } from './resource';
import { syncEmbeddedGroups } from './service';

// Folds an OIDC sign-in's `groups` claim into the same scim_group /
// scim_group_member tables a SCIM sync writes to, so a group mapped to a project in
// god mode grants access on an instance that uses OIDC, SCIM, or both. Runs after
// every successful callback, not just the first one, so membership follows the
// provider going forward.
//
// The claim lives in the ID token, not necessarily the userinfo response some
// providers keep small. The token's signature was checked by the OAuth client
// before the session was opened; reading an optional claim off it here needs no
// second check.
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Called by the OIDC callback with the user it just signed in and the ID token it
// verified. Best effort throughout: a decode failure, a missing claim, or a DB
// error is logged and swallowed rather than surfaced, since none of it should turn
// a successful sign-in into a failed one.
export async function syncOidcGroups(userId: string, idToken: string | null): Promise<void> {
  try {
    if (!idToken) return;
    const claims = decodeJwtPayload(idToken);
    const names = groupDisplayNames(claims?.groups);
    await syncEmbeddedGroups(userId, names);
  } catch (error) {
    console.error('[scim] OIDC group sync failed:', error);
  }
}
