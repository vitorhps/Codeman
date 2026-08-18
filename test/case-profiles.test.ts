/**
 * @fileoverview Tests for the per-case Claude account binding (case-profiles.ts)
 * and host account discovery (claude-profiles.ts).
 *
 * Port: N/A (pure modules + real temp-HOME filesystem, no server)
 *
 * `test/setup.ts` repoints HOME at a per-file fixture and `dataPath()` resolves
 * `homedir()` at CALL time, so these write real files into the fixture rather
 * than mocking `node:fs` — the mocking route would stub out exactly the
 * existence checks this module's behavior turns on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  caseProfilesPath,
  readCaseProfiles,
  writeCaseProfiles,
  isUsableConfigDir,
  clearCaseProfile,
  withCaseConfigDir,
} from '../src/case-profiles.js';
import { listClaudeProfiles } from '../src/claude-profiles.js';

const HOME = homedir();
const ALT_PROFILE = join(HOME, '.claude-acme');
const CASE_DIR = join(HOME, 'codeman-cases', 'acme');

beforeEach(() => {
  mkdirSync(ALT_PROFILE, { recursive: true });
  writeFileSync(join(ALT_PROFILE, '.credentials.json'), '{}');
  mkdirSync(CASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(ALT_PROFILE, { recursive: true, force: true });
  if (existsSync(caseProfilesPath())) rmSync(caseProfilesPath(), { force: true });
});

describe('case-profiles store', () => {
  it('round-trips a binding', async () => {
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    expect(await readCaseProfiles()).toEqual({ [CASE_DIR]: ALT_PROFILE });
  });

  it('treats a missing or corrupt registry as empty rather than throwing', async () => {
    expect(await readCaseProfiles()).toEqual({});
    writeFileSync(caseProfilesPath(), 'not json at all');
    expect(await readCaseProfiles()).toEqual({});
    // An array parses as JSON but is not a path→dir map.
    writeFileSync(caseProfilesPath(), '["nope"]');
    expect(await readCaseProfiles()).toEqual({});
  });

  it('drops entries that are not absolute-path pairs', async () => {
    writeFileSync(
      caseProfilesPath(),
      JSON.stringify({
        [CASE_DIR]: ALT_PROFILE,
        'relative/case': ALT_PROFILE, // key not absolute
        [join(HOME, 'other')]: '.claude-acme', // value not absolute
        [join(HOME, 'third')]: 42, // value not a string
      })
    );
    expect(await readCaseProfiles()).toEqual({ [CASE_DIR]: ALT_PROFILE });
  });

  it('clears a binding and is a no-op for an unbound path', async () => {
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    await clearCaseProfile(join(HOME, 'nothing-here'));
    expect(await readCaseProfiles()).toEqual({ [CASE_DIR]: ALT_PROFILE });
    await clearCaseProfile(CASE_DIR);
    expect(await readCaseProfiles()).toEqual({});
  });
});

describe('isUsableConfigDir', () => {
  it('accepts an existing absolute directory', async () => {
    expect(await isUsableConfigDir(ALT_PROFILE)).toBe(true);
  });

  it('rejects relative paths, missing dirs, files and empty input', async () => {
    expect(await isUsableConfigDir('.claude-acme')).toBe(false);
    expect(await isUsableConfigDir(join(HOME, '.claude-does-not-exist'))).toBe(false);
    expect(await isUsableConfigDir(join(ALT_PROFILE, '.credentials.json'))).toBe(false);
    expect(await isUsableConfigDir('')).toBe(false);
  });
});

describe('withCaseConfigDir', () => {
  it('injects the dir bound to the working directory', async () => {
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    expect(await withCaseConfigDir(undefined, CASE_DIR)).toEqual({ CLAUDE_CONFIG_DIR: ALT_PROFILE });
  });

  it('merges into existing overrides without dropping them', async () => {
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    expect(await withCaseConfigDir({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, CASE_DIR)).toEqual({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CONFIG_DIR: ALT_PROFILE,
    });
  });

  it('lets an explicit request-level CLAUDE_CONFIG_DIR win over the case binding', async () => {
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    const explicit = { CLAUDE_CONFIG_DIR: join(HOME, '.claude') };
    expect(await withCaseConfigDir(explicit, CASE_DIR)).toEqual(explicit);
  });

  it('leaves an unbound working directory alone', async () => {
    await writeCaseProfiles({ [join(HOME, 'codeman-cases', 'other')]: ALT_PROFILE });
    expect(await withCaseConfigDir(undefined, CASE_DIR)).toBeUndefined();
  });

  it('ignores a binding whose dir was deleted, rather than failing the spawn', async () => {
    await writeCaseProfiles({ [CASE_DIR]: join(HOME, '.claude-deleted') });
    expect(await withCaseConfigDir(undefined, CASE_DIR)).toBeUndefined();
  });

  /**
   * The reason the registry is keyed by path rather than name. Two users each own a
   * case called `acme` in their own space; only the one actually bound may inherit
   * the account. A name-keyed registry matched both and handed user B the admin's
   * client credentials.
   */
  it('does not leak a binding to a same-named case in another case space', async () => {
    const otherUsersAcme = join(HOME, 'codeman-users', 'bob', 'cases', 'acme');
    mkdirSync(otherUsersAcme, { recursive: true });
    await writeCaseProfiles({ [CASE_DIR]: ALT_PROFILE });
    expect(await withCaseConfigDir(undefined, otherUsersAcme)).toBeUndefined();
    expect(await withCaseConfigDir(undefined, CASE_DIR)).toEqual({ CLAUDE_CONFIG_DIR: ALT_PROFILE });
  });
});

describe('listClaudeProfiles', () => {
  it('lists the default profile first and discovers ~/.claude-* siblings', async () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    const found = await listClaudeProfiles();
    expect(found[0]?.isDefault).toBe(true);
    expect(found.find((p) => p.path === ALT_PROFILE)).toMatchObject({
      label: '.claude-acme',
      isDefault: false,
      hasCredentials: true,
    });
  });

  it('skips ~/.claude-* dirs that are not config dirs', async () => {
    const decoy = join(HOME, '.claude-backup-2024');
    mkdirSync(decoy, { recursive: true });
    try {
      expect((await listClaudeProfiles()).some((p) => p.path === decoy)).toBe(false);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('reports a config dir that has no credentials yet as needing login', async () => {
    const fresh = join(HOME, '.claude-fresh');
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(fresh, '.claude.json'), '{}');
    try {
      expect((await listClaudeProfiles()).find((p) => p.path === fresh)?.hasCredentials).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('surfaces the account email when the dir has been logged into', async () => {
    writeFileSync(
      join(ALT_PROFILE, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'ops@acme.test' } })
    );
    expect((await listClaudeProfiles()).find((p) => p.path === ALT_PROFILE)?.email).toBe('ops@acme.test');
  });
});
