import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { atomicWrite } from '../utils/atomicWrite';
import { lock, unlock } from '../utils/fileLock';
import { getAppVersion } from './scaffold';
import { busyReason } from './appActivity';

/**
 * Whether a newer version of the app is out, and how this install gets it (#284). This part only checks and says how;
 * installing comes later (npm) or stays with the desktop app's own updater.
 *
 * Apart from AI tool runs the user starts or turns on, the check is the only request the app makes on its own, once a
 * day while automatic checks are on: it asks for the newest version number (the npm registry through the user's own
 * npm and its settings, with npm's own update notice off, or the desktop app's update feed on GitHub) and sends
 * nothing from the workspace.
 *
 * State, shared by every dashboard of this user, in `~/.gtd/updates.json` (or GTD_UPDATES_PATH), changed under a lock:
 *   { auto_check, dismissed, results: { <source>: { latest, checked_at, error } } }
 * A result belongs to where it came from (npm, or a desktop channel on a system), so installs of different kinds on
 * one computer never take each other's answers.
 */

const PACKAGE = '@bertonha/getthingsdone';
const RELEASES = 'https://github.com/geovanneb/get-things-done/releases';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 20_000;
/** "Check now" asks again at most this often, whoever presses it. */
const CHECK_NOW_GAP_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

/** How this copy of the app was installed, so it is told how to update. */
export type InstallKind = 'desktop' | 'npm' | 'npm-local' | 'npx' | 'source';

export interface UpdateStatus {
  current: string;
  /** The newest version found, or null before the first check. */
  latest: string | null;
  /** Strictly newer than `current`: an older or equal `latest` is never offered. */
  newer: boolean;
  kind: InstallKind;
  /** The release channel checked (one, stable, for now). */
  channel: string;
  /**
   * - `self`: the desktop app downloads it by itself and asks to restart;
   * - `command`: run `commands`;
   * - `manual`: this copy can't update itself (an unsigned or preview desktop build, a copy run from source).
   */
  how: 'self' | 'command' | 'manual';
  commands: string[];
  release_url: string;
  notes_url: string | null;
  auto_check: boolean;
  /** The version whose notice the user put off with Later. */
  dismissed: string | null;
  checked_at: string | null;
  checking: boolean;
  error: string | null;
  /** Something important running now (a recording, a transcription, an AI tool run): no notice meanwhile. */
  busy: string | null;
}

interface Result { latest: string | null; checked_at: string | null; error: string | null }

interface Stored {
  auto_check: boolean;
  dismissed: string | null;
  results: Record<string, Result>;
  /** The file was there but could not be read: automatic checks stay off until the user turns them on again. */
  unreadable: boolean;
}

/** Where the newest version comes from; replaced in tests so they never reach the network. */
export type LatestSource = (kind: InstallKind, channel: string) => Promise<string>;

// Semantic versioning 2.0: no leading zeros, non-empty identifiers, build metadata allowed (and ignored for order).
const NUM = '(0|[1-9]\\d{0,8})';
const IDENT = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && SEMVER.test(value);
}

/** Below zero when `a` comes before `b`, by semantic versioning's precedence. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const p = x[4].split('.');
  const q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]!);
    const qn = /^\d+$/.test(q[i]!);
    // Numbers of any length (no leading zeros): the longer is larger, else as text.
    if (pn && qn) { if (p[i]!.length !== q[i]!.length) return p[i]!.length - q[i]!.length; if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}

/** The app's own folder: where its package.json is (the same file `getAppVersion` reads). */
function appRoot(): string {
  for (const dir of [path.resolve(__dirname, '../../..'), path.resolve(__dirname, '../../../..')]) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return process.cwd();
}

/**
 * The desktop app says so (GTD_INSTALL); otherwise judged from where the app's files are. In npm's global folder
 * (`<prefix>/lib/node_modules`, or `…\npm\node_modules` on Windows) nothing above `node_modules` is a project; a copy
 * in a project's own `node_modules` is updated in that project instead.
 */
export function installKind(root = appRoot(), env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): InstallKind {
  if (env['GTD_INSTALL'] === 'desktop') return 'desktop';
  const parts = root.split(/[\\/]+/);
  if (parts.includes('_npx')) return 'npx';
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return 'source';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const above = parts.slice(0, at).join(sep) || sep;
  return exists(`${above}${sep}package.json`) ? 'npm-local' : 'npm';
}

function storePath(): string {
  return process.env['GTD_UPDATES_PATH'] || path.join(os.homedir(), '.gtd', 'updates.json');
}

function readResult(value: unknown): Result | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  return {
    latest: isVersion(o['latest']) ? o['latest'] : null,
    checked_at: typeof o['checked_at'] === 'string' ? o['checked_at'] : null,
    error: typeof o['error'] === 'string' ? o['error'].slice(0, 300) : null,
  };
}

async function readStored(): Promise<Stored> {
  const text = await fsp.readFile(storePath(), 'utf-8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : ''));
  if (text === null) return { auto_check: true, dismissed: null, results: {}, unreadable: false };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = null; }
  // Damaged or unreadable: what the user chose is unknown, so nothing is asked by itself until they say again.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { auto_check: false, dismissed: null, results: {}, unreadable: true };
  const o = raw as Record<string, unknown>;
  // The user's choice must be there, as written by the dashboard: anything else is as unknown as a damaged file.
  if (typeof o['auto_check'] !== 'boolean') return { auto_check: false, dismissed: null, results: {}, unreadable: true };
  const results: Record<string, Result> = {};
  const found = o['results'] && typeof o['results'] === 'object' && !Array.isArray(o['results']) ? o['results'] as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(found)) { const r = readResult(value); if (r && /^[a-z0-9:-]{1,80}$/.test(key)) results[key] = r; }
  return { auto_check: o['auto_check'], dismissed: isVersion(o['dismissed']) ? o['dismissed'] : null, results, unreadable: false };
}

/** Reads, changes and writes the state as one step, across dashboards. */
async function changeStored(change: (s: Stored) => Stored): Promise<Stored> {
  await fsp.mkdir(path.dirname(storePath()), { recursive: true });
  const held = await lock(`${storePath()}.lock`, LOCK_WAIT_MS, () => Object.assign(new Error('The update settings are being saved elsewhere; try again in a moment'), { statusCode: 409 }));
  try {
    const next = change(await readStored());
    await atomicWrite(storePath(), JSON.stringify({ auto_check: next.auto_check, dismissed: next.dismissed, results: next.results }, null, 2) + '\n');
    return { ...next, unreadable: false };
  } finally {
    await unlock(held);
  }
}

/** The npm that comes with this node, run by node itself (never a shell): the user's own npm settings apply. */
function npmCli(): string | null {
  const real = path.dirname(fs.realpathSync(process.execPath));
  const linked = path.dirname(process.execPath);
  const candidates = [
    path.join(real, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(real, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(real, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(linked, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** npm's arguments for the one question asked: no update notice of its own, no other request. */
export const NPM_VIEW_ARGS = ['view', `${PACKAGE}@latest`, 'version', '--json', '--prefer-online', '--update-notifier=false', '--no-audit', '--no-fund'];

function run(file: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false' };
  delete env['NODE_OPTIONS'];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: CHECK_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true, env }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** The update feed file electron-updater reads for this channel on this system. */
export function feedFile(channel: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? `${channel}-mac.yml` : platform === 'linux' ? `${channel}-linux.yml` : `${channel}.yml`;
}

/** Asks npm (as the user set it up) for the newest version; `cli` is npm's own script, found next to this node. */
export async function npmLatest(cli: string | null = npmCli()): Promise<string> {
  if (!cli) throw new Error('npm could not be found next to this node');
  const out = JSON.parse(await run(process.execPath, [cli, ...NPM_VIEW_ARGS]));
  if (!isVersion(out)) throw new Error('npm gave no version');
  return out;
}

const defaultSource: LatestSource = async (kind, channel) => {
  if (kind === 'desktop') {
    const feed = await fetchText(`${RELEASES}/latest/download/${feedFile(channel)}`);
    const version = /^version:\s*['"]?([^'"\s]+)/m.exec(feed)?.[1];
    if (!isVersion(version)) throw new Error('The update feed gave no version');
    return version;
  }
  return npmLatest();
};

let source: LatestSource = defaultSource;
let checking: Promise<Stored> | null = null;
let lastAsked = 0;

/** Tests only: where the newest version comes from (and "Check now" may ask again at once). */
export function setLatestSourceForTests(next: LatestSource | null): void {
  source = next ?? defaultSource;
  lastAsked = 0;
}

/** Whether this process may not ask the network at all: tests, the smoke test, or GTD_DISABLE_UPDATES=1. */
function disabled(): boolean {
  return process.env['GTD_DISABLE_UPDATES'] === '1' || process.env['NODE_ENV'] === 'test';
}

function channel(): string {
  const c = process.env['GTD_UPDATE_CHANNEL'];
  return c && /^[a-z0-9-]{1,40}$/.test(c) ? c : 'latest';
}

/** Where this install's answer comes from, and so where it is kept. */
function sourceKey(kind = installKind()): string {
  return kind === 'desktop' ? `desktop:${channel()}:${process.platform}` : 'npm';
}

/** Asks for the newest version once (concurrent asks share it) and keeps the answer, or why it failed. */
async function check(): Promise<Stored> {
  checking ??= (async () => {
    lastAsked = Date.now();
    const at = new Date().toISOString();
    const key = sourceKey();
    let result: Result;
    if (disabled() && source === defaultSource) {
      // Never the network where it is turned off; an injected source (tests) may still answer.
      result = { latest: null, checked_at: at, error: 'Checking for updates is turned off here' };
    } else {
      try {
        const latest = await source(installKind(), channel());
        if (!isVersion(latest)) throw new Error('No version was given');
        result = { latest, checked_at: at, error: null };
      } catch (err) {
        result = { latest: null, checked_at: at, error: (err as Error).message || 'The check failed' };
      }
    }
    // A failure keeps the version found before, with why this check did not work.
    return changeStored((s) => ({ ...s, results: { ...s.results, [key]: result.error ? { latest: s.results[key]?.latest ?? null, checked_at: at, error: result.error } : result } }));
  })().finally(() => { checking = null; });
  return checking;
}

async function describe(stored: Stored, workspace: string | null): Promise<UpdateStatus> {
  const current = getAppVersion();
  const kind = installKind();
  const result = stored.results[sourceKey(kind)] ?? { latest: null, checked_at: null, error: null };
  const newer = result.latest !== null && isVersion(current) && compareVersions(result.latest, current) > 0;
  const how: UpdateStatus['how'] = kind === 'desktop' ? (process.env['GTD_UPDATES'] === 'on' ? 'self' : 'manual') : kind === 'source' ? 'manual' : 'command';
  const target = newer ? result.latest! : 'latest';
  const commands = kind === 'npm' ? [`npm install -g ${PACKAGE}@${target}`, 'gtd stop', 'gtd upgrade', 'gtd start']
    : kind === 'npm-local' ? ['npx gtd stop', `npm install ${PACKAGE}@${target}`, 'npx gtd upgrade', 'npx gtd start']
      : kind === 'npx' ? ['stop', 'upgrade', 'start'].map((c) => `npx ${PACKAGE}@${target} ${c}`) : [];
  return {
    current, latest: result.latest, newer, kind, channel: channel(), how, commands,
    release_url: `${RELEASES}/latest`,
    notes_url: result.latest ? `${RELEASES}/tag/v${result.latest}` : null,
    auto_check: stored.auto_check, dismissed: stored.dismissed, checked_at: result.checked_at,
    checking: checking !== null,
    error: stored.unreadable ? 'The saved update settings could not be read, so automatic checks are off until you turn them on again' : result.error,
    busy: await busyReason(workspace).catch(() => null),
  };
}

export async function updateStatus(workspace: string | null = null): Promise<UpdateStatus> {
  return describe(await readStored(), workspace);
}

/** "Check now": asks again, unless it was asked a moment ago (then the answer being fetched or kept is used). */
export async function checkNow(workspace: string | null = null): Promise<UpdateStatus> {
  if (checking) return describe(await checking, workspace);
  if (Date.now() - lastAsked < CHECK_NOW_GAP_MS) return updateStatus(workspace);
  return describe(await check(), workspace);
}

export async function setAutoCheck(value: unknown, workspace: string | null = null): Promise<UpdateStatus> {
  if (typeof value !== 'boolean') throw Object.assign(new Error('Invalid auto_check: use true or false'), { statusCode: 400 });
  return describe(await changeStored((s) => ({ ...s, auto_check: value })), workspace);
}

/** "Later" on the notice: hides it for that version only, in every dashboard. */
export async function dismiss(version: unknown, workspace: string | null = null): Promise<UpdateStatus> {
  const key = sourceKey();
  const stored = await changeStored((s) => {
    if (!isVersion(version) || version !== s.results[key]?.latest) throw Object.assign(new Error('Invalid version: only the version found can be put off'), { statusCode: 400 });
    return { ...s, dismissed: version };
  });
  return describe(stored, workspace);
}

/**
 * Checks a minute after start and then hourly, asking only when the last answer is a day old and checks are on.
 * Returns how to stop it, for when the server closes.
 */
export function startUpdateChecks(): () => void {
  if (disabled()) return () => {};
  const due = async () => {
    const stored = await readStored();
    if (!stored.auto_check) return;
    const checked = stored.results[sourceKey()]?.checked_at;
    const last = checked ? Date.parse(checked) : 0;
    if (!(Date.now() - last < CHECK_EVERY_MS)) await check();
  };
  const first = setTimeout(() => void due().catch(() => {}), 60_000);
  const hourly = setInterval(() => void due().catch(() => {}), 60 * 60 * 1000);
  first.unref();
  hourly.unref();
  return () => { clearTimeout(first); clearInterval(hourly); };
}
