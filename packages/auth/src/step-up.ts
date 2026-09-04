// Step-up re-authentication.
//
// Some actions are dangerous enough that "you have a valid session" is not a good
// enough answer: deleting a user, revoking someone else's device, rotating an API
// key, turning MFA off. For those the account must have re-entered its password
// recently — a window stored on the session row as `step_up_expires_at`, opened by
// POST /auth/step-up and closed by time.
//
// It defends against the borrowed-laptop case that session lifetime alone cannot:
// a session can legitimately be 90 days old, but a re-typed password is minutes
// old by construction.

export const STEP_UP_MODES = ['sensitive', 'always', 'disabled'] as const;
export type StepUpMode = (typeof STEP_UP_MODES)[number];

export const DEFAULT_STEP_UP_MODE: StepUpMode = 'sensitive';

// How long a re-authentication counts for. Long enough to finish a run of admin
// work, short enough that an unattended screen is not an open door.
export const DEFAULT_STEP_UP_WINDOW_MINUTES = 15;
export const MIN_STEP_UP_WINDOW_MINUTES = 1;
export const MAX_STEP_UP_WINDOW_MINUTES = 8 * 60;

export function isStepUpMode(value: unknown): value is StepUpMode {
  return typeof value === 'string' && (STEP_UP_MODES as readonly string[]).includes(value);
}

export function clampStepUpWindow(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_STEP_UP_WINDOW_MINUTES;
  return Math.min(
    MAX_STEP_UP_WINDOW_MINUTES,
    Math.max(MIN_STEP_UP_WINDOW_MINUTES, Math.round(minutes)),
  );
}

export function stepUpExpiry(windowMinutes: number, now = Date.now()): Date {
  return new Date(now + clampStepUpWindow(windowMinutes) * 60 * 1000);
}

// Whether an action needs a fresh window.
//
//   'always'    — every gated action asks, whatever it is
//   'sensitive' — only actions the caller marks sensitive (the default)
//   'disabled'  — never ask; the session alone is enough
//
// `disabled` is a deliberate escape hatch for an instance where the extra prompt
// is not worth it. It is a per-user preference, not an instance one, so it cannot
// be turned off for everybody by accident.
export function stepUpRequired(mode: StepUpMode, sensitivity: 'sensitive' | 'routine'): boolean {
  if (mode === 'disabled') return false;
  if (mode === 'always') return true;
  return sensitivity === 'sensitive';
}

export function stepUpWindowOpen(expiresAt: Date | null | undefined, now = Date.now()): boolean {
  return expiresAt != null && expiresAt.getTime() > now;
}
