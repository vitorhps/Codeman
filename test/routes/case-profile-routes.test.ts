/**
 * @fileoverview Route tests for the per-case Claude account binding
 * (`GET /api/claude-profiles`, `PUT /api/cases/:name/claude-profile`).
 *
 * Port: N/A (app.inject())
 *
 * Deliberately a separate file from case-routes.test.ts: that suite mocks
 * `node:fs/promises` down to four functions, and these handlers stat real
 * directories to decide whether a config dir is usable. Mocking that away
 * would remove the only thing worth asserting, so this file runs on the real
 * filesystem inside the per-file temp HOME that test/setup.ts provides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { caseProfilesPath, readCaseProfiles } from '../../src/case-profiles.js';

const HOME = homedir();
const ALT_PROFILE = join(HOME, '.claude-acme');
const CASES_DIR = join(HOME, 'codeman-cases');
const CASE_DIR = join(CASES_DIR, 'acme');

/** Mirrors the envelope hook in src/web/server.ts so statuses match production. */
async function createHarness(authUser?: { username: string; role: 'admin' | 'user' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (authUser) app.addHook('onRequest', async (req) => void (req.authUser = authUser));
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  registerCaseRoutes(app, createMockRouteContext() as never);
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  mkdirSync(ALT_PROFILE, { recursive: true });
  writeFileSync(join(ALT_PROFILE, '.credentials.json'), '{}');
  mkdirSync(CASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(ALT_PROFILE, { recursive: true, force: true });
  rmSync(CASES_DIR, { recursive: true, force: true });
  if (existsSync(caseProfilesPath())) rmSync(caseProfilesPath(), { force: true });
});

describe('GET /api/claude-profiles', () => {
  it('lists the discoverable accounts', async () => {
    const app = await createHarness();
    const res = await app.inject({ method: 'GET', url: '/api/claude-profiles' });
    expect(res.statusCode).toBe(200);
    const profiles = res.json().data.profiles as Array<{ path: string }>;
    expect(profiles.some((p) => p.path === ALT_PROFILE)).toBe(true);
    await app.close();
  });
});

describe('PUT /api/cases/:name/claude-profile', () => {
  it('stores the binding under the case PATH, not its name', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cases/acme/claude-profile',
      payload: { configDir: ALT_PROFILE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ configDir: ALT_PROFILE });
    expect(await readCaseProfiles()).toEqual({ [CASE_DIR]: ALT_PROFILE });
    await app.close();
  });

  it('clears the binding on an empty configDir', async () => {
    const app = await createHarness();
    await app.inject({ method: 'PUT', url: '/api/cases/acme/claude-profile', payload: { configDir: ALT_PROFILE } });
    const res = await app.inject({ method: 'PUT', url: '/api/cases/acme/claude-profile', payload: { configDir: '' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ configDir: null });
    expect(await readCaseProfiles()).toEqual({});
    await app.close();
  });

  it('rejects a config dir that does not exist', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cases/acme/claude-profile',
      payload: { configDir: join(HOME, '.claude-missing') },
    });
    expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
    expect(res.json().errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    expect(await readCaseProfiles()).toEqual({});
    await app.close();
  });

  it('rejects a relative config dir', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/cases/acme/claude-profile',
      payload: { configDir: '.claude-acme' },
    });
    expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
    await app.close();
  });

  it('rejects a case name that is not in the safe format', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cases/${encodeURIComponent('../escape')}/claude-profile`,
      payload: { configDir: ALT_PROFILE },
    });
    expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
    await app.close();
  });
});
