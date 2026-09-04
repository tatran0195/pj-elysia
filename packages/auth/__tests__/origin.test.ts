import { describe, expect, it } from 'bun:test';
import {
  canonicalOrigin,
  clientIp,
  configuredOrigins,
  isStateChangingMethod,
  originAllowed,
  sessionCookieOptions,
} from '../src/origin';

const env = {
  APP_URL: 'https://plan.example.com',
  API_URL: 'https://api.example.com',
  NODE_ENV: 'production',
} as unknown as NodeJS.ProcessEnv;

function request(method: string, origin?: string): { method: string; headers: Headers } {
  const headers = new Headers();
  if (origin !== undefined) headers.set('origin', origin);
  return { method, headers };
}

describe('configuredOrigins', () => {
  it('normalizes and de-duplicates the configured URLs', () => {
    expect(
      configuredOrigins({
        APP_URL: 'https://Plan.Example.com/',
        API_URL: 'https://plan.example.com',
        NODE_ENV: 'production',
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(['https://plan.example.com']);
  });

  it('adds the local dev origins outside production only', () => {
    const dev = configuredOrigins({ APP_URL: 'http://localhost:3001' } as NodeJS.ProcessEnv);
    expect(dev).toContain('http://localhost:8080');
    expect(configuredOrigins(env)).not.toContain('http://localhost:8080');
  });

  it('accepts extra origins from the environment', () => {
    const origins = configuredOrigins({
      ...env,
      EXTRA_TRUSTED_ORIGINS: 'https://a.example.com, https://b.example.com',
    } as NodeJS.ProcessEnv);
    expect(origins).toContain('https://a.example.com');
    expect(origins).toContain('https://b.example.com');
  });
});

describe('originAllowed', () => {
  it('ignores safe methods', () => {
    expect(originAllowed(request('GET', 'https://evil.example'), env)).toBe(true);
    expect(originAllowed(request('HEAD', 'https://evil.example'), env)).toBe(true);
  });

  it('allows a configured origin on a state-changing request', () => {
    expect(originAllowed(request('POST', 'https://plan.example.com'), env)).toBe(true);
    expect(originAllowed(request('DELETE', 'https://api.example.com'), env)).toBe(true);
  });

  it('rejects any other origin', () => {
    expect(originAllowed(request('POST', 'https://evil.example'), env)).toBe(false);
    expect(originAllowed(request('POST', 'https://plan.example.com.evil.example'), env)).toBe(
      false,
    );
    expect(originAllowed(request('POST', 'null'), env)).toBe(false);
  });

  it('allows a request with no Origin at all (curl, server to server)', () => {
    expect(originAllowed(request('POST'), env)).toBe(true);
  });

  it('cannot be talked into trusting a forwarded host header', () => {
    const headers = new Headers({
      origin: 'https://evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(originAllowed({ method: 'POST', headers }, env)).toBe(false);
  });
});

describe('sessionCookieOptions', () => {
  it('marks the cookie secure from the configured origin, not the request', () => {
    expect(sessionCookieOptions(env)).toEqual({ secure: true, domain: null });
  });

  it('is not secure on a plain http deployment', () => {
    expect(
      sessionCookieOptions({ APP_URL: 'http://localhost:8080' } as NodeJS.ProcessEnv).secure,
    ).toBe(false);
  });

  it('carries a domain only when one is configured', () => {
    expect(sessionCookieOptions({ ...env, COOKIE_DOMAIN: '.example.com' }).domain).toBe(
      '.example.com',
    );
    expect(sessionCookieOptions({ ...env, COOKIE_DOMAIN: '  ' }).domain).toBeNull();
  });
});

describe('canonicalOrigin', () => {
  it('prefers the app URL', () => {
    expect(canonicalOrigin(env)).toBe('https://plan.example.com');
  });
});

describe('clientIp', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 10.0.0.1' });

  it('ignores the forwarded header when no proxy is declared', () => {
    expect(clientIp(headers, '10.0.0.1', env)).toBe('10.0.0.1');
  });

  it('steps past the declared number of proxies', () => {
    expect(clientIp(headers, '10.0.0.1', { ...env, TRUST_PROXY_HOPS: '1' })).toBe('10.0.0.1');
    expect(clientIp(headers, '10.0.0.1', { ...env, TRUST_PROXY_HOPS: '2' })).toBe('70.41.3.18');
  });

  it('falls back to the socket address when the chain is too short', () => {
    const short = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(clientIp(short, '10.0.0.1', { ...env, TRUST_PROXY_HOPS: '3' })).toBe('10.0.0.1');
  });
});

describe('isStateChangingMethod', () => {
  it('covers the mutating verbs, in any casing', () => {
    expect(['POST', 'put', 'Patch', 'DELETE'].every(isStateChangingMethod)).toBe(true);
    expect(['GET', 'head', 'OPTIONS'].some(isStateChangingMethod)).toBe(false);
  });
});
