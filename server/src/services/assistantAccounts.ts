import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { findCommand } from './aiToolDetection';
import { accountOf, childEnv, killTree, launch, probeAuthStatus, stopTree } from './agentRunner';
import { processAlive } from './runState';
import { ASSISTANTS, FOLDERS, accountKey, authChanged, checkFolder, folderInUse, forFolder, insideHome, realHome, savedChoice, withChoice, type AssistantId } from './assistantAccountFolder';
import { codexAccount, codexEnv } from './chat/codex';
import { CopilotChatAdapter, copilotEnv } from './chat/copilot';
import { updateUserConfig, userConfigPath } from './userConfig';
import { WorkspaceService } from './workspace';

/**
 * Settings → Assistant accounts (#505): which sign-in Claude Code, Codex and GitHub Copilot use when the dashboard
 * starts them (the chat, and the background runner), and signing in or out from the app. One model for every
 * assistant: a config folder per sign-in, named by the assistant's own variable (assistantAccountFolder.ts), the
 * tool's own status check, and the tool's own sign-in and sign-out commands.
 *
 * - Candidates: the default (the dashboard's own environment), folders next to it named like `~/.claude-*` that hold
 *   that assistant's config, and folders added from the app. Each is checked with the tool's own status, under that
 *   folder; no model is called.
 * - Signing in starts the tool's own sign-in for that folder. Claude Code and Codex need no terminal: they open the
 *   browser and wait for it to come back on this computer. Their input is closed, so the app never types anything
 *   into them. The app never sees or stores credentials; it remembers only which method an account last used.
 * - GitHub Copilot: its account can only be read by opening a session, so the card shows the account the chat check
 *   found and says how to sign in from a terminal; it offers no choice of account.
 */

export type SignInMethod = 'claudeai' | 'sso' | 'console' | 'browser';

interface Probe { signed_in: boolean; method: string | null; email: string | null; organization: string | null; plan: string | null }

interface Provider {
  id: AssistantId;
  label: string;
  command: string;
  /** The assistant's environment, cleaned by its own rules, before a folder is set. */
  baseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Who is signed in under `env`; null when it cannot be checked. */
  probe(bin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Probe | null>;
  /** Whether that sign-in is the plan the dashboard uses (not an API key or another provider). */
  planOk(probe: Probe): boolean;
  /** The sign-in methods offered, the first is the default; empty when the app cannot sign in. */
  methods: SignInMethod[];
  loginArgs(method: SignInMethod): string[];
  logoutArgs: string[] | null;
  /** How single sign-on works: a method of its own, or a choice on the sign-in page that opens. */
  sso: 'option' | 'on_page' | null;
  /** The tool maker's own sign-in pages (origin and path, exactly): only such a link is shown. */
  signInPages: string[];
}

const PROVIDERS: Record<AssistantId, Provider> = {
  'claude-code': {
    id: 'claude-code', label: 'Claude Code', command: 'claude',
    baseEnv: (base) => childEnv(base),
    probe: async (bin, env, timeoutMs) => {
      const auth = await probeAuthStatus(bin, env, timeoutMs);
      if (!auth) return null;
      const signedIn = auth['loggedIn'] === true;
      const account = signedIn ? accountOf(auth) : null;
      return { signed_in: signedIn, method: signedIn && typeof auth['authMethod'] === 'string' ? auth['authMethod'].slice(0, 40) : null, email: account?.email ?? null, organization: account?.organization ?? null, plan: account?.plan ?? null };
    },
    planOk: (p) => p.method === 'claude.ai',
    methods: ['claudeai', 'sso', 'console'],
    loginArgs: (method) => ['auth', 'login', `--${method}`],
    logoutArgs: ['auth', 'logout'],
    sso: 'option',
    // As Claude Code prints and opens them (claude.ai, claude.com), and the Console's for --console.
    signInPages: ['https://claude.ai/oauth/authorize', 'https://claude.com/cai/oauth/authorize', 'https://console.anthropic.com/oauth/authorize'],
  },
  codex: {
    id: 'codex', label: 'OpenAI Codex', command: 'codex',
    baseEnv: (base) => codexEnv(base),
    probe: async (bin, env) => {
      const a = await codexAccount(bin, env);
      return a ? { signed_in: a.signed_in, method: a.method, email: a.email, organization: null, plan: a.plan } : null;
    },
    planOk: (p) => p.method === 'chatgpt',
    methods: ['browser'],
    loginArgs: () => ['login'],
    logoutArgs: ['logout'],
    sso: 'on_page',
    signInPages: ['https://auth.openai.com/oauth/authorize'],
  },
  copilot: {
    id: 'copilot', label: 'GitHub Copilot', command: 'copilot',
    baseEnv: (base) => copilotEnv(base),
    probe: async () => null,
    planOk: () => true,
    methods: [],
    loginArgs: () => [],
    logoutArgs: null,
    sso: null,
    signInPages: [],
  },
};

export interface AssistantAccount {
  /** The folder's path; null for the default (the dashboard's own environment). */
  folder: string | null;
  /** The folder as shown under Details, with `~` for the home folder. */
  path_label: string;
  /** The name the user gave this account, if any. */
  name: string | null;
  kind: 'default' | 'found' | 'added';
  chosen: boolean;
  /** Why the account cannot be used now; null when it can. */
  problem: string | null;
  /** Null when it could not be checked. */
  signed_in: boolean | null;
  /** False for an API key or another provider, which the dashboard does not use. */
  plan_ok: boolean | null;
  account: { email: string | null; organization: string | null; plan: string | null } | null;
  /** The sign-in method this account last used from the app. */
  last_method: SignInMethod | null;
  /** The same sign-in in a terminal, for Details. */
  terminal_command: string;
}

export interface AssistantView {
  id: AssistantId;
  label: string;
  installed: boolean;
  /** Whether another account can be chosen and added. */
  choosable: boolean;
  /** Sign-in methods the app can start, the default first; empty when it cannot sign in. */
  methods: SignInMethod[];
  sso: 'option' | 'on_page' | null;
  /** Whether Sign out is offered. */
  can_sign_out: boolean;
  chosen: string | null;
  accounts: AssistantAccount[];
}

export interface SignInState {
  assistant: AssistantId;
  folder: string | null;
  method: SignInMethod;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** The sign-in link the tool printed, when it printed one (only the tool maker's own https pages). */
  url: string | null;
  /** What went wrong, in plain words: a fixed sentence, never what the tool said. */
  message: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AccountsView { assistants: AssistantView[]; sign_in: SignInState | null }

const PROBE_TTL_MS = 5_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGOUT_TIMEOUT_MS = 30_000;
const NAME_MAX = 40;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

function provider(id: unknown): Provider {
  if (typeof id !== 'string' || !ASSISTANTS.includes(id as AssistantId)) throw httpError(404, 'Unknown assistant.');
  return PROVIDERS[id as AssistantId];
}

/** One shared probe per tool and folder for a few seconds: a page that asks twice starts one check. */
const probes = new Map<string, { at: number; result: Promise<Probe | null> }>();

/** For tests, and after a sign-in or sign-out: the next check asks the tool again. */
export function forgetProbes(): void {
  probes.clear();
}

/**
 * The sign-in or sign-out going now, if any: one at a time on this computer. Taken before anything is awaited and kept
 * until the tool's process has exited, so two requests can never both change a sign-in, and shutdown finds the
 * process. Shutdown marks it cancelled: a request still being checked then starts no tool at all. A lock file in the
 * app's config folder keeps a second dashboard on this computer out too.
 */
interface Operation {
  kind: 'sign-in' | 'sign-out';
  assistant: AssistantId;
  child: ChildProcess | null;
  lock: string | null;
  cancelled: boolean;
  exited: Promise<void>;
  release: () => void;
}
let operation: Operation | null = null;
/** The last sign-in shown in Settings. */
let signIn: (SignInState & { timer: ReturnType<typeof setTimeout> | null }) | null = null;

function signInView(): SignInState | null {
  if (!signIn) return null;
  const { timer: _timer, ...view } = signIn;
  return view;
}

/** The lock file for one assistant's sign-in changes, shared by every dashboard on this computer. */
function lockFile(id: AssistantId): string {
  return path.join(path.dirname(userConfigPath()), `assistant-sign-in-${id}.lock`);
}

/** For tests: points in taking the lock where another dashboard could act. */
export const lockHooks: { afterLinkFailed?: () => void; underRecovery?: () => void; afterRecovery?: () => void } = {};

const unique = () => `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
const readOrNull = (file: string) => { try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } };

/** Publishes `source` under `name` with a hard link: fails (false) when the name exists, so exactly one caller wins. */
function linkOnce(source: string, name: string): boolean {
  try {
    fs.linkSync(source, name);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Whether a lock's contents name a process that is gone (or nothing readable): only such a lock may be removed. */
function deadOwner(contents: string): boolean {
  const pid = Number(contents.trim());
  return !(Number.isInteger(pid) && pid > 0 && (pid === process.pid || processAlive(pid)));
}

/**
 * Takes the computer-wide lock, or null when another live dashboard holds it.
 *
 * Acquiring: our process id is written to a file of our own, which is hard-linked to the lock's name. A link fails when
 * the name exists, so the lock never appears without its owner's id and exactly one dashboard wins.
 *
 * Recovering a lock whose process is gone never touches a live owner's lock: it happens only under a second lock,
 * `<lock>.recover`, taken the same way. Under it the lock is read again and removed only if it still names a process
 * that is gone; no one else can replace it meanwhile (acquiring needs the name free, recovering needs the mutex). Then
 * the mutex is released and the normal link is tried once more: if another dashboard linked first, this one reports
 * busy. A mutex whose dashboard's process is gone (it stopped during recovery) is removed; a live one is kept whatever its
 * age.
 */
function takeLock(id: AssistantId): string | null {
  const file = lockFile(id);
  const mutex = `${file}.recover`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = `${file}.${unique()}`;
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    if (linkOnce(mine, file)) return file;
    lockHooks.afterLinkFailed?.();
    const seen = readOrNull(file);
    if (seen === null) return linkOnce(mine, file) ? file : null; // released meanwhile
    if (!deadOwner(seen)) return null;
    if (!linkOnce(mine, mutex)) {
      // Another dashboard is recovering it. Its mutex is removed only when that dashboard's process is gone, never by
      // age: a live one may just be paused (the computer slept). Accepted limit: two dashboards removing the same dead
      // mutex at the same instant may both recover; that needs a crash inside the recovery itself.
      const holder = readOrNull(mutex);
      if (holder === null || !deadOwner(holder)) return null;
      fs.rmSync(mutex, { force: true });
      if (!linkOnce(mine, mutex)) return null;
    }
    try {
      lockHooks.underRecovery?.();
      const now = readOrNull(file);
      if (now !== null && deadOwner(now)) fs.rmSync(file, { force: true });
    } finally {
      if (readOrNull(mutex) === String(process.pid)) fs.rmSync(mutex, { force: true });
    }
    lockHooks.afterRecovery?.();
    return linkOnce(mine, file) ? file : null;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/** Reserves the one sign-in or sign-out slot, synchronously. Throws 409 when one is going here or in another dashboard. */
function reserve(kind: Operation['kind'], id: AssistantId): Operation {
  if (operation) throw httpError(409, operation.kind === 'sign-in' ? 'A sign-in is already going. Finish or cancel it first.' : 'Signing out is still going. Try again in a moment.');
  const lock = takeLock(id);
  if (!lock) throw httpError(409, 'Another dashboard on this computer is signing in or out of this assistant. Try again in a moment.');
  let done!: () => void;
  const exited = new Promise<void>((r) => { done = r; });
  const op: Operation = {
    kind, assistant: id, child: null, lock, cancelled: false, exited,
    release: () => {
      if (operation === op) operation = null;
      if (op.lock && readOrNull(op.lock)?.trim() === String(process.pid)) fs.rmSync(op.lock, { force: true });
      op.lock = null;
      done();
    },
  };
  operation = op;
  return op;
}

/** Refuses to start a tool for a reservation shutdown cancelled meanwhile (and frees it). */
function startable(op: Operation): void {
  if (op.cancelled) {
    op.release();
    throw httpError(409, 'The dashboard is stopping. Try again once it has started.');
  }
}

/** Ends a sign-in or sign-out still going, or about to start (the dashboard stops). */
export async function stopSignIn(): Promise<void> {
  const current = operation;
  if (!current) return;
  current.cancelled = true;
  if (signIn?.status === 'running' && current.kind === 'sign-in') {
    signIn.status = 'cancelled';
    signIn.ended_at = new Date().toISOString();
  }
  if (current.child) await stopTree(current.child);
  // A request still being checked sees the cancellation before it would start anything, and frees the slot. Bounded,
  // so a tool that does not end cannot hold the dashboard's shutdown.
  await Promise.race([current.exited, new Promise((r) => setTimeout(r, 8_000).unref())]);
}

/** Takes colour codes and terminal links out of a tool's output. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The first link in a tool's output that is one of `pages` (origin and path exactly, https only); null otherwise. */
export function signInUrl(output: string, pages: string[]): string | null {
  for (const match of plain(output).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    if (match[0].length > 4096) continue;
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'https:' && !url.username && !url.password && pages.includes(`${url.origin}${url.pathname}`)) return match[0];
    } catch { /* not a link */ }
  }
  return null;
}

/** A literal the shell takes as it is: PowerShell single quotes (an apostrophe doubled), POSIX single quotes. */
function quote(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that signs in to this account from a terminal. */
export function terminalCommand(id: AssistantId, folder: string | null, method: SignInMethod | null = null, platform: NodeJS.Platform = process.platform): string {
  const login = id === 'claude-code' ? `claude auth login${method && method !== 'claudeai' ? ` --${method}` : ''}` : `${PROVIDERS[id].command} login`;
  if (!folder) return login;
  const name = FOLDERS[id].envVar;
  return platform === 'win32' ? `$env:${name}=${quote(folder, platform)}; ${login}` : `${name}=${quote(folder, platform)} ${login}`;
}

/** A folder name from what the user called the account: letters, digits and `-` only, never a path. */
export function folderSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return slug || 'account';
}

const methodKey = (folder: string | null) => folder ?? '';

export class AssistantAccountsService {
  /** Everything is for tests: by default the installed tools, this process's environment and the open workspace. */
  constructor(
    private readonly binary: (command: string) => string | null = (command) => findCommand(command),
    private readonly base: () => NodeJS.ProcessEnv = () => process.env,
    private readonly probeTimeoutMs = 15_000,
    private readonly loginTimeoutMs = LOGIN_TIMEOUT_MS,
    private readonly copilotStatus: () => Promise<{ signed_in: boolean | null; plan: string | null }> = defaultCopilotStatus,
  ) {}

  private pathLabel(id: AssistantId, folder: string | null): string {
    const home = realHome();
    const dir = folder ?? this.base()[FOLDERS[id].envVar] ?? path.join(home, FOLDERS[id].defaultName);
    return insideHome(dir, home) ? `~${path.sep}${path.relative(home, dir)}` : dir;
  }

  /**
   * The assistant's environment with this folder: for a named folder its variable set and every variable that signs
   * in on its own removed, so the folder's own sign-in is the one used; the default keeps the dashboard's own.
   */
  private envFor(p: Provider, folder: string | null): NodeJS.ProcessEnv {
    const env = p.baseEnv(this.base());
    return folder ? forFolder(p.id, env, folder) : env;
  }

  /** Folders next to the default that hold this assistant's config: real folders, never links. */
  private async found(id: AssistantId): Promise<string[]> {
    const spec = FOLDERS[id];
    const home = realHome();
    const names = await fsp.readdir(home).catch(() => [] as string[]);
    const dirs: string[] = [];
    for (const name of names.sort()) {
      if (!name.startsWith(spec.prefix) || !/^[A-Za-z0-9._-]+$/.test(name.slice(spec.prefix.length))) continue;
      const dir = path.join(home, name);
      const stat = await fsp.lstat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      // A marker counts only as a plain file or folder of its own: a link could borrow another account's files.
      const marks = await Promise.all(spec.markers.map((m) => fsp.lstat(path.join(dir, m)).then((st) => st.isFile() || st.isDirectory(), () => false)));
      if (marks.some(Boolean)) dirs.push(dir);
    }
    return dirs;
  }

  /** The candidates without their sign-in: default first, then found and added folders, each once. */
  private async candidates(id: AssistantId): Promise<{ chosen: string | null; list: { folder: string | null; kind: AssistantAccount['kind']; problem: string | null }[] }> {
    const choice = savedChoice(id);
    const list: { folder: string | null; kind: AssistantAccount['kind']; problem: string | null }[] = [{ folder: null, kind: 'default', problem: null }];
    if (!FOLDERS[id].choosable) return { chosen: null, list };
    const inherited = this.base()[FOLDERS[id].envVar];
    let inheritedReal: string | null = null;
    try { inheritedReal = inherited ? fs.realpathSync.native(inherited) : null; } catch { /* shown as the default */ }
    const seen = new Set<string>();
    const push = (folder: string, kind: 'found' | 'added') => {
      if (seen.has(folder) || folder === inheritedReal) return;
      seen.add(folder);
      let problem: string | null = null;
      try { checkFolder(id, folder, choice.added); } catch (err) { problem = (err as Error).message; }
      list.push({ folder, kind, problem });
    };
    for (const folder of await this.found(id)) push(folder, 'found');
    for (const folder of choice.added) push(folder, 'added');
    // A chosen folder that is no longer found or added is still listed, with its problem, so it can be changed.
    if (choice.folder && !seen.has(choice.folder)) push(choice.folder, 'added');
    return { chosen: choice.folder ?? null, list };
  }

  /** The candidate for `folder` (null: the default); refused when it is not one of them or cannot be used now. */
  private async candidate(id: AssistantId, folder: unknown): Promise<string | null> {
    if (folder === null || folder === undefined || folder === '') return null;
    if (!FOLDERS[id].choosable) throw httpError(400, 'This assistant uses its default account only.');
    const { list } = await this.candidates(id);
    const match = typeof folder === 'string' ? list.find((c) => c.folder === path.resolve(folder)) : undefined;
    if (!match) throw httpError(400, 'That account is not in the list.');
    if (match.problem) throw httpError(400, match.problem);
    return checkFolder(id, match.folder, savedChoice(id).added);
  }

  private probe(p: Provider, bin: string, folder: string | null): Promise<Probe | null> {
    const env = this.envFor(p, folder);
    // Keyed by the sign-in generation too: after a sign-in, sign-out or switch, every folder is checked again.
    const key = `${p.id}\0${bin}\0${accountKey(p.id, env)}`;
    const cached = probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result;
    const result = p.probe(bin, env, this.probeTimeoutMs);
    probes.set(key, { at: Date.now(), result });
    return result;
  }

  private async view(p: Provider): Promise<AssistantView> {
    const bin = this.binary(p.command);
    const { chosen, list } = await this.candidates(p.id);
    const choice = savedChoice(p.id);
    const accounts = await Promise.all(list.map(async ({ folder, kind, problem }): Promise<AssistantAccount> => {
      let probe: Probe | null = null;
      let signedIn: boolean | null = null;
      let plan: string | null = null;
      if (p.id === 'copilot') {
        if (bin) ({ signed_in: signedIn, plan } = await this.copilotStatus());
      } else if (bin && !problem) {
        probe = await this.probe(p, bin, folder);
        signedIn = probe ? probe.signed_in : null;
      }
      const last = choice.methods[methodKey(folder)];
      return {
        folder, path_label: this.pathLabel(p.id, folder), name: folder ? choice.names[folder] ?? null : null, kind, problem,
        chosen: folder === null ? chosen === null : folder === chosen,
        signed_in: signedIn,
        plan_ok: probe && probe.signed_in ? p.planOk(probe) : null,
        account: probe && probe.signed_in ? { email: probe.email, organization: probe.organization, plan: probe.plan } : plan ? { email: null, organization: null, plan } : null,
        last_method: last && p.methods.includes(last as SignInMethod) ? last as SignInMethod : null,
        terminal_command: terminalCommand(p.id, folder, (last as SignInMethod) ?? null),
      };
    }));
    return {
      id: p.id, label: p.label, installed: bin !== null, choosable: FOLDERS[p.id].choosable, methods: p.methods, sso: p.sso,
      can_sign_out: p.logoutArgs !== null, chosen, accounts,
    };
  }

  /** Every assistant with its accounts, checked in parallel, and the sign-in going now, if any. */
  async list(): Promise<AccountsView> {
    return { assistants: await Promise.all(ASSISTANTS.map((id) => this.view(PROVIDERS[id]))), sign_in: signInView() };
  }

  /** Chooses the account the assistant uses from its next start (null: the default). A run or chat going keeps its own. */
  async choose(id: unknown, folder: unknown): Promise<AccountsView> {
    const p = provider(id);
    const dir = await this.candidate(p.id, folder);
    await updateUserConfig((current) => withChoice(current, p.id, (c) => {
      const next = { ...c };
      if (dir) next.folder = dir;
      else delete next.folder;
      return next;
    }));
    authChanged(p.id);
    return this.list();
  }

  /** Adds an existing config folder by its path, also outside the home folder. Nothing in it is read or changed. */
  async addFolder(id: unknown, folder: unknown): Promise<AccountsView> {
    const p = provider(id);
    if (!FOLDERS[p.id].choosable) throw httpError(400, 'This assistant uses its default account only.');
    if (typeof folder !== 'string' || !path.isAbsolute(folder.trim())) throw httpError(400, 'Give the full path of the folder.');
    const resolved = path.resolve(folder.trim());
    // Checked as if added: the point of adding is to allow a folder outside the home folder.
    const dir = checkFolder(p.id, resolved, [resolved]);
    await updateUserConfig((current) => withChoice(current, p.id, (c) => (c.added.includes(dir) ? c : { ...c, added: [...c.added, dir] })));
    return this.list();
  }

  /** Takes an added account off the list; its folder stays. Refused while it is the chosen one. */
  async removeFolder(id: unknown, folder: unknown): Promise<AccountsView> {
    const p = provider(id);
    if (typeof folder !== 'string' || !folder) throw httpError(400, 'Give the full path of the folder.');
    const resolved = path.resolve(folder);
    await updateUserConfig((current) => withChoice(current, p.id, (c) => {
      if (c.folder === resolved) throw httpError(409, 'This account is in use. Choose another one first.');
      if (!c.added.includes(resolved)) throw httpError(404, 'That account was not added from the app.');
      const names = { ...c.names };
      delete names[resolved];
      return { ...c, added: c.added.filter((a) => a !== resolved), names };
    }));
    return this.list();
  }

  /**
   * Makes an empty config folder for another account, on explicit request only, named after what the user called it
   * (`~/.claude-work` for "Work"; `-2`, `-3` … when taken), and adds it to the list. The user never types a path.
   */
  async createAccount(id: unknown, name: unknown): Promise<{ folder: string; view: AccountsView }> {
    const p = provider(id);
    if (!FOLDERS[p.id].choosable) throw httpError(400, 'This assistant uses its default account only.');
    // eslint-disable-next-line no-control-regex
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.trim().length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name))) {
      throw httpError(400, `Give the account a name of up to ${NAME_MAX} characters, or none.`);
    }
    const label = typeof name === 'string' && name.trim() ? name.trim() : null;
    const home = realHome();
    const slug = folderSlug(label ?? '');
    let folder = '';
    for (let n = 1; n <= 50; n++) {
      folder = path.join(home, `${FOLDERS[p.id].prefix}${slug}${n === 1 ? '' : `-${n}`}`);
      try {
        await fsp.mkdir(folder, { mode: 0o700 });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n === 50) throw httpError(500, 'Could not make a place for the new account in your home folder.');
      }
    }
    await updateUserConfig((current) => withChoice(current, p.id, (c) => ({
      ...c, added: c.added.includes(folder) ? c.added : [...c.added, folder], names: label ? { ...c.names, [folder]: label } : c.names,
    })));
    return { folder, view: await this.list() };
  }

  /** The sign-in going now or the last one, if any. */
  signInState(): SignInState | null {
    return signInView();
  }

  /**
   * Starts the tool's own sign-in for the account. No terminal is needed: the tool opens the browser and waits for it
   * on this computer. Its input is closed, so it can never be asked to read a code or a password from the app.
   */
  async startSignIn(id: unknown, folder: unknown, method: unknown): Promise<SignInState> {
    const p = provider(id);
    if (!p.methods.length) throw httpError(400, `${p.label} cannot be signed in from the dashboard. Sign in from a terminal.`);
    const chosenMethod = (method === undefined || method === null ? p.methods[0] : method) as SignInMethod;
    if (!p.methods.includes(chosenMethod)) throw httpError(400, 'Choose one of the sign-in methods offered.');
    const bin = this.binary(p.command);
    if (!bin) throw httpError(409, `${p.label} is not installed on this computer.`);
    // Reserved before anything is awaited, and held until the tool's process has exited.
    const op = reserve('sign-in', p.id);
    let child: ChildProcess;
    let dir: string | null;
    try {
      dir = await this.candidate(p.id, folder);
    } catch (err) {
      op.release();
      throw err;
    }
    startable(op);
    try {
      child = launch(bin, p.loginArgs(chosenMethod), os.homedir(), this.envFor(p, dir));
    } catch (err) {
      op.release();
      throw err;
    }
    op.child = child;
    const state: NonNullable<typeof signIn> = {
      assistant: p.id, folder: dir, method: chosenMethod, status: 'running', url: null, message: null,
      started_at: new Date().toISOString(), ended_at: null, timer: null,
    };
    signIn = state;
    // What the tool prints is read only for its sign-in link, while it runs; it is never returned or kept.
    let output = '';
    const hear = (chunk: string) => {
      if (state.url || state.ended_at) return;
      output = (output + chunk).slice(-16384);
      state.url = signInUrl(output, p.signInPages);
      if (state.url) output = '';
    };
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', hear);
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', hear);
    const end = (status: SignInState['status'], message: string | null) => {
      if (state.ended_at) return;
      if (state.timer) clearTimeout(state.timer);
      output = '';
      state.status = state.status === 'cancelled' ? 'cancelled' : status;
      state.message = state.status === 'failed' ? message : null;
      state.ended_at = new Date().toISOString();
      // Whatever happened, the sign-in in that folder may have changed: no earlier check or approval is reused.
      authChanged(p.id);
      if (state.status === 'succeeded') {
        void updateUserConfig((current) => withChoice(current, p.id, (c) => ({ ...c, methods: { ...c.methods, [methodKey(dir)]: chosenMethod } }))).catch(() => {});
      }
    };
    state.timer = setTimeout(() => {
      state.timer = null;
      killTree(child, true);
      end('failed', 'The sign-in was not finished within 10 minutes. Try again.');
    }, this.loginTimeoutMs);
    state.timer.unref?.();
    child.on('error', () => { end('failed', 'The sign-in could not be started. Try again.'); op.release(); });
    child.on('exit', (code) => { end(code === 0 ? 'succeeded' : 'failed', 'The sign-in did not finish. Try again.'); op.release(); });
    return signInView()!;
  }

  /** Cancels the sign-in going now. */
  async cancelSignIn(): Promise<SignInState | null> {
    const current = operation;
    if (current?.kind === 'sign-in' && current.child && signIn?.status === 'running') {
      signIn.status = 'cancelled';
      await stopTree(current.child);
    }
    return signInView();
  }

  /**
   * The tool's own sign-out for the account, after the user confirmed. Refused while a sign-in or sign-out is going,
   * or while a run or a chat of this dashboard uses that account.
   */
  async signOut(id: unknown, folder: unknown, confirmed: unknown): Promise<AccountsView> {
    const p = provider(id);
    if (confirmed !== true) throw httpError(400, 'Confirm signing out first.');
    if (!p.logoutArgs) throw httpError(400, `${p.label} cannot be signed out from the dashboard. Sign out from a terminal.`);
    const bin = this.binary(p.command);
    if (!bin) throw httpError(409, `${p.label} is not installed on this computer.`);
    const op = reserve('sign-out', p.id);
    let code: number | null;
    try {
      const dir = await this.candidate(p.id, folder);
      const env = this.envFor(p, dir);
      if (folderInUse(p.id, env)) throw httpError(409, 'The dashboard is using this account right now. Sign out once it has finished.');
      const args = p.logoutArgs;
      if (op.cancelled) throw httpError(409, 'The dashboard is stopping. Try again once it has started.');
      code = await new Promise<number | null>((resolve) => {
        let child: ChildProcess;
        try { child = launch(bin, args, os.homedir(), env); } catch { resolve(null); return; }
        op.child = child;
        const timer = setTimeout(() => killTree(child, true), LOGOUT_TIMEOUT_MS);
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('exit', (exit) => { clearTimeout(timer); resolve(exit); });
      });
    } finally {
      op.release();
    }
    authChanged(p.id);
    if (code !== 0) throw httpError(502, 'Signing out did not work. Try again.');
    return this.list();
  }
}

const copilot = new CopilotChatAdapter();

/** Copilot's sign-in as the chat's own check finds it in the open workspace (it opens a session to tell). */
async function defaultCopilotStatus(): Promise<{ signed_in: boolean | null; plan: string | null }> {
  let workspace: string;
  try { workspace = new WorkspaceService().getWorkspacePath(); } catch { return { signed_in: null, plan: null }; }
  const status = await copilot.status(workspace).catch(() => null);
  if (!status) return { signed_in: null, plan: null };
  if (status.problems.some((x) => x.code === 'not_signed_in')) return { signed_in: false, plan: null };
  if (status.ready) return { signed_in: true, plan: status.plan };
  return { signed_in: null, plan: null };
}
