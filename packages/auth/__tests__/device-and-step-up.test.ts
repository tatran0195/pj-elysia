import { describe, expect, it } from 'bun:test';
import { deriveDeviceLabel } from '../src/device';
import {
  DEFAULT_STEP_UP_WINDOW_MINUTES,
  MAX_STEP_UP_WINDOW_MINUTES,
  clampStepUpWindow,
  isStepUpMode,
  stepUpExpiry,
  stepUpRequired,
  stepUpWindowOpen,
} from '../src/step-up';

describe('deriveDeviceLabel', () => {
  const cases: [string, string][] = [
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox on Linux'],
    ['curl/8.5.0', 'curl'],
  ];

  for (const [userAgent, label] of cases) {
    it(`labels ${label}`, () => {
      expect(deriveDeviceLabel(userAgent)).toBe(label);
    });
  }

  it('is empty rather than wrong when it cannot tell', () => {
    expect(deriveDeviceLabel(null)).toBe('');
    expect(deriveDeviceLabel('')).toBe('');
    expect(deriveDeviceLabel('some-internal-agent/1.0')).toBe('');
  });
});

describe('step-up policy', () => {
  it('asks for sensitive actions by default and skips routine ones', () => {
    expect(stepUpRequired('sensitive', 'sensitive')).toBe(true);
    expect(stepUpRequired('sensitive', 'routine')).toBe(false);
  });

  it('asks for everything on always, and nothing on disabled', () => {
    expect(stepUpRequired('always', 'routine')).toBe(true);
    expect(stepUpRequired('disabled', 'sensitive')).toBe(false);
  });

  it('clamps the window to something sane', () => {
    expect(clampStepUpWindow(0)).toBe(1);
    expect(clampStepUpWindow(15)).toBe(15);
    expect(clampStepUpWindow(99_999)).toBe(MAX_STEP_UP_WINDOW_MINUTES);
    expect(clampStepUpWindow(Number.NaN)).toBe(DEFAULT_STEP_UP_WINDOW_MINUTES);
  });

  it('opens a window that expires', () => {
    const now = Date.UTC(2026, 0, 1);
    const expiry = stepUpExpiry(15, now);
    expect(expiry.getTime()).toBe(now + 15 * 60_000);
    expect(stepUpWindowOpen(expiry, now)).toBe(true);
    expect(stepUpWindowOpen(expiry, now + 15 * 60_000 + 1)).toBe(false);
    expect(stepUpWindowOpen(null, now)).toBe(false);
  });

  it('validates the mode coming off the wire', () => {
    expect(isStepUpMode('always')).toBe(true);
    expect(isStepUpMode('sometimes')).toBe(false);
    expect(isStepUpMode(undefined)).toBe(false);
  });
});
