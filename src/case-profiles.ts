/**
 * @fileoverview Per-case Claude account binding (`CLAUDE_CONFIG_DIR`).
 *
 * #255 shipped the transport — `POST /api/sessions { envOverrides }` accepts
 * `CLAUDE_CONFIG_DIR` and `tmux setenv` carries it into the pane — but closed
 * explicitly out of scope on the binding itself: "Case settings are
 * localStorage-only (per-device), which is the wrong home for a per-client
 * account binding … the follow-up is a server-side per-case field". This is
 * that field, stored in `case-profiles.json` beside `linked-cases.json`.
 *
 * **Keyed by the case's absolute PATH, not its name.** Case names are only unique
 * within one case space, and multi-user mode gives every user their own
 * (`~/codeman-users/<name>/cases`). A name-keyed registry therefore leaks across
 * users: an admin binding a case `acme` to a client account would silently hand
 * those credentials to any other user who also has a case called `acme`, because
 * both resolve the same name. Paths are globally unique, so the same lookup that
 * finds a binding also proves it belongs to this case — and session creation
 * carries a working directory anyway, so the path is what we already have.
 *
 * The value is a PATH, not a secret: the credentials stay in the config dir it
 * points at. That is also why it survives `getEnvOverridesForPersist()` (session.ts)
 * — dropping it would silently move a rebuilt session back to the default account.
 *
 * @module case-profiles
 */

import fs from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { dataPath } from './config/instance.js';

/**
 * Absolute case directory → absolute `CLAUDE_CONFIG_DIR`.
 *
 * Both sides are absolute paths; see the module note on why the key is the path.
 */
export type CaseProfiles = Record<string, string>;

/** Path of the per-case account binding registry. */
export function caseProfilesPath(): string {
  return dataPath('case-profiles.json');
}

/** Read the registry; a missing or corrupt file is an empty registry, never a throw. */
export async function readCaseProfiles(): Promise<CaseProfiles> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(caseProfilesPath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CaseProfiles = {};
    for (const [casePath, configDir] of Object.entries(parsed as Record<string, unknown>)) {
      // Both sides absolute or the entry cannot mean anything; a hand-edited or
      // downgraded file must not be able to inject a relative path into the env.
      if (typeof configDir === 'string' && isAbsolute(casePath) && isAbsolute(configDir)) {
        out[casePath] = configDir;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the registry (pretty-printed, matching linked-cases.json). */
export async function writeCaseProfiles(profiles: CaseProfiles): Promise<void> {
  await fs.writeFile(caseProfilesPath(), JSON.stringify(profiles, null, 2));
}

/**
 * Is `dir` usable as a `CLAUDE_CONFIG_DIR`?
 *
 * Absolute + existing directory only. We deliberately do NOT require
 * `.credentials.json`: binding a case to a config dir BEFORE its first `/login`
 * is the normal onboarding order for a client account, and demanding the file
 * would make the empty-dir case unconfigurable.
 */
export async function isUsableConfigDir(dir: string): Promise<boolean> {
  if (!dir || !isAbsolute(dir)) return false;
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Drop the binding for a case path, if any. Called when a case is deleted. */
export async function clearCaseProfile(casePath: string): Promise<void> {
  const profiles = await readCaseProfiles();
  if (!(casePath in profiles)) return;
  delete profiles[casePath];
  await writeCaseProfiles(profiles);
}

/**
 * Merge the account bound to `workingDir`'s case into caller-supplied overrides.
 *
 * An explicit `CLAUDE_CONFIG_DIR` in the request always wins — the API contract
 * from #255 stays intact, and a one-off spawn can override the case default
 * without editing it.
 *
 * A binding whose directory has since been deleted is ignored rather than
 * injected: a stale entry must never be able to fail a spawn.
 */
export async function withCaseConfigDir(
  envOverrides: Record<string, string> | undefined,
  workingDir: string
): Promise<Record<string, string> | undefined> {
  if (envOverrides?.CLAUDE_CONFIG_DIR) return envOverrides;

  const profiles = await readCaseProfiles();
  const configDir = profiles[workingDir];
  if (!configDir || !(await isUsableConfigDir(configDir))) return envOverrides;

  return { ...(envOverrides || {}), CLAUDE_CONFIG_DIR: configDir };
}
