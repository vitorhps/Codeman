/**
 * @fileoverview Discovery of the Claude account config dirs present on this host.
 *
 * Read-only inspection of the filesystem, kept apart from `case-profiles.ts` (which
 * owns the case→account BINDING) because the two change for different reasons: this
 * one tracks how the Claude CLI lays out `CLAUDE_CONFIG_DIR` on disk, that one tracks
 * what Codeman does with a chosen dir.
 *
 * It exists so the per-case picker can offer real accounts instead of a free-text
 * path — the same reasoning as the CLI resolvers (`claude-cli-resolver.ts` et al):
 * a control whose only possible outcome is a typo is worse than no control.
 *
 * @module claude-profiles
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** One discoverable Claude account config dir. */
export interface ClaudeProfileInfo {
  /** Absolute config dir — the value written into `CLAUDE_CONFIG_DIR`. */
  path: string;
  /** Display label: the path relative to home (`.claude`, `.claude-acme`, …). */
  label: string;
  /** True for the CLI default (`~/.claude`), which needs no override. */
  isDefault: boolean;
  /** Account email from `.claude.json`, when the dir has been logged into. */
  email?: string;
  /** False = no credentials yet, so the first session there runs `/login`. */
  hasCredentials: boolean;
}

/** Does `dir` exist as a directory? */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Does `file` exist? */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `oauthAccount.emailAddress` out of a config dir's `.claude.json`.
 *
 * Async and best-effort: the file also carries the CLI's cached history, so it runs
 * to a few hundred KB on a well-used account and must not be parsed on the event
 * loop's back. A dir with no readable account block simply has no email to show.
 */
async function readProfileEmail(dir: string): Promise<string | undefined> {
  // The default profile keeps this at ~/.claude.json; relocated dirs keep their own copy inside.
  const candidates =
    dir === join(homedir(), '.claude')
      ? [join(homedir(), '.claude.json'), join(dir, '.claude.json')]
      : [join(dir, '.claude.json')];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as {
        oauthAccount?: { emailAddress?: string };
      };
      const email = parsed?.oauthAccount?.emailAddress;
      if (typeof email === 'string' && email) return email;
    } catch {
      // unreadable / not JSON / no account block — try the next candidate
    }
  }
  return undefined;
}

/** Build the info record for one config dir, or null when it is not one. */
async function describeProfile(dir: string, isDefault: boolean): Promise<ClaudeProfileInfo | null> {
  if (!(await isDirectory(dir))) return null;
  const home = homedir();
  const [email, hasCredentials] = await Promise.all([readProfileEmail(dir), exists(join(dir, '.credentials.json'))]);
  return {
    path: dir,
    label: dir.startsWith(home + '/') ? dir.slice(home.length + 1) : dir,
    isDefault,
    email,
    hasCredentials,
  };
}

/**
 * Discover `~/.claude` plus every `~/.claude-*` sibling that looks like a config dir.
 *
 * Sibling scan rather than an arbitrary tree walk: relocated dirs conventionally sit
 * next to the default one, and an operator who keeps theirs elsewhere can still bind
 * it by POSTing the absolute path. The `.credentials.json` OR `.claude.json` test is
 * what keeps unrelated `.claude-*` folders (backups, worktree scratch) out of the list
 * without also excluding a fresh dir that has not been logged into yet.
 *
 * @returns the default profile first, then siblings in directory order.
 */
export async function listClaudeProfiles(): Promise<ClaudeProfileInfo[]> {
  const home = homedir();
  const out: ClaudeProfileInfo[] = [];

  const defaultProfile = await describeProfile(join(home, '.claude'), true);
  if (defaultProfile) out.push(defaultProfile);

  // unreadable home — the default entry above is still useful on its own
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    // Symlinked profile dirs are common (shared skills/plugins), so accept both.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!/^\.claude-[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const dir = join(home, entry.name);
    const looksLikeConfigDir =
      (await exists(join(dir, '.credentials.json'))) || (await exists(join(dir, '.claude.json')));
    if (!looksLikeConfigDir) continue;
    const info = await describeProfile(dir, false);
    if (info) out.push(info);
  }

  return out;
}
