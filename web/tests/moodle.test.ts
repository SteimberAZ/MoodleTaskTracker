import { describe, expect, it, vi } from 'vitest';
import {
  connectToMoodle,
  moodleErrorMessage,
  parseSiteInfo,
  parseTokenResponse,
  resolveMoodleUrl,
} from '@/lib/moodle';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('resolveMoodleUrl', () => {
  it('defaults to the UTM site and strips trailing slashes', () => {
    expect(resolveMoodleUrl(undefined)).toBe('https://evirtual.utm.edu.ec');
    expect(resolveMoodleUrl('https://moodle.example.com/sub/')).toBe('https://moodle.example.com/sub');
  });

  it('rejects non-https, credentials in the URL and garbage', () => {
    expect(resolveMoodleUrl('http://moodle.example.com')).toBeNull();
    expect(resolveMoodleUrl('https://u:p@moodle.example.com')).toBeNull();
    expect(resolveMoodleUrl('not a url')).toBeNull();
  });
});

describe('moodleErrorMessage', () => {
  it('maps known codes to friendly Spanish', () => {
    expect(moodleErrorMessage('invalidlogin')).toBe('Usuario o contraseña incorrectos');
  });

  it('falls back to a generic message without leaking odd characters', () => {
    expect(moodleErrorMessage(undefined)).toContain('No se pudo conectar');
    expect(moodleErrorMessage('weird<code>')).not.toContain('<');
  });
});

describe('parse helpers', () => {
  it('parses a token response', () => {
    expect(parseTokenResponse({ token: 'abc', privatetoken: 'x' })).toEqual({ ok: true, value: { token: 'abc' } });
    const bad = parseTokenResponse({ error: 'Invalid login', errorcode: 'invalidlogin' });
    expect(bad).toEqual({ ok: false, message: 'Usuario o contraseña incorrectos' });
    expect(parseTokenResponse('html').ok).toBe(false);
  });

  it('parses site info and detects web service exceptions', () => {
    expect(parseSiteInfo({ userid: 7, fullname: 'Ana Pérez' })).toEqual({
      ok: true,
      value: { userid: 7, fullname: 'Ana Pérez' },
    });
    expect(parseSiteInfo({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'x' }).ok).toBe(false);
    expect(parseSiteInfo({ fullname: 'no id' }).ok).toBe(false);
  });
});

describe('connectToMoodle', () => {
  it('returns the token and user after both calls succeed, sending form-encoded bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'tok123' }))
      .mockResolvedValueOnce(json({ userid: 42, fullname: 'Ana' }));
    const r = await connectToMoodle('https://m.example.com', 'ana', 's3cret', fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: { token: 'tok123', siteUserId: 42, fullname: 'Ana' } });

    const [url1, init1] = fetchMock.mock.calls[0];
    expect(url1).toBe('https://m.example.com/login/token.php');
    expect(init1.method).toBe('POST');
    expect(init1.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init1.body).toContain('service=moodle_mobile_app');
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toBe('https://m.example.com/webservice/rest/server.php');
    expect(init2.body).toContain('wsfunction=core_webservice_get_site_info');
    expect(init2.body).not.toContain('s3cret');
  });

  it('reports invalid credentials without calling the web service', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: 'x', errorcode: 'invalidlogin' }));
    const r = await connectToMoodle('https://m.example.com', 'ana', 'bad', fetchMock as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, message: 'Usuario o contraseña incorrectos' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a token that the web service refuses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ token: 'tok' }))
      .mockResolvedValueOnce(json({ exception: 'moodle_exception', errorcode: 'invalidtoken' }));
    const r = await connectToMoodle('https://m.example.com', 'ana', 'pw', fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });

  it('returns a generic error on network failure and never echoes the password', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom pw-secret'));
    const r = await connectToMoodle('https://m.example.com', 'ana', 'pw-secret', fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('pw-secret');
  });
});
