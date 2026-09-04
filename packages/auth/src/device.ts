// A short human label for the device a session was created on, shown on the
// account's Security page next to "last seen" so someone can recognise a session
// they do not remember and revoke it.
//
// Parsed from the user agent, which is a guess by nature: the point is to be
// recognisable ("Chrome on macOS"), not accurate. Unknown input yields an empty
// string, and the UI renders "Unknown device" for it.

interface Rule {
  pattern: RegExp;
  label: string;
}

// Order matters: the more specific engine has to win. Edge and Opera both claim
// Chrome, Chrome claims Safari, and every WebView claims something.
const BROWSERS: Rule[] = [
  { pattern: /\bEdg(?:e|A|iOS)?\//, label: 'Edge' },
  { pattern: /\bOPR\/|\bOpera\//, label: 'Opera' },
  { pattern: /\bSamsungBrowser\//, label: 'Samsung Internet' },
  { pattern: /\bFirefox\/|\bFxiOS\//, label: 'Firefox' },
  { pattern: /\bCriOS\//, label: 'Chrome' },
  { pattern: /\bChrome\//, label: 'Chrome' },
  { pattern: /\bSafari\//, label: 'Safari' },
  { pattern: /\bcurl\//, label: 'curl' },
];

const PLATFORMS: Rule[] = [
  { pattern: /\biPhone\b/, label: 'iPhone' },
  { pattern: /\biPad\b/, label: 'iPad' },
  { pattern: /\bAndroid\b/, label: 'Android' },
  { pattern: /\bWindows NT\b/, label: 'Windows' },
  { pattern: /\bMac OS X\b|\bMacintosh\b/, label: 'macOS' },
  { pattern: /\bCrOS\b/, label: 'ChromeOS' },
  { pattern: /\bLinux\b/, label: 'Linux' },
];

function match(rules: Rule[], userAgent: string): string | null {
  for (const rule of rules) {
    if (rule.pattern.test(userAgent)) return rule.label;
  }
  return null;
}

export function deriveDeviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return '';
  const browser = match(BROWSERS, userAgent);
  const platform = match(PLATFORMS, userAgent);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? '';
}
