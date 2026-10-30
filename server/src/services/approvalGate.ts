import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';

/**
 * The approval step of an unattended apply. The workspace asks before any write to context/, stakeholders/ and
 * outputs/; with nobody there to answer, Claude Code asks this instead (`--permission-prompt-tool`). It allows a
 * write only to a file the user accepted in the dashboard, or into the update's own folder, and refuses
 * everything else it is asked about, Bash included. What the workspace allows without asking (context-updates/,
 * tasks/ with the shipped rules) does not reach it: the workspace rules stay the boundary there, as when the user
 * runs the command.
 *
 * Paths are compared as written, under the workspace folder, and any symlink on the way (a link to a folder or a
 * file, or a dangling one) is refused, so a link can never make a write land elsewhere. This is a check before the
 * write, not an operating-system boundary: something else changing the folders between the check and the write is
 * outside what it can stop.
 *
 * It is a tiny MCP server (newline-delimited JSON-RPC over stdio). Its script, settings and decision log live in a
 * private temporary folder outside the workspace, created for one run and removed after it, and it is started with
 * the same Node that runs the dashboard, so nothing needs installing and nothing in the workspace can change it.
 */

/** The MCP tool name Claude Code is told to ask: server `gtd_gate`, tool `approve`. */
export const GATE_TOOL = 'mcp__gtd_gate__approve';

const SCRIPT = String.raw`'use strict';
// Written by Get Things Done for one apply run, in a private temporary folder.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Tools that write one file through file_path. NotebookEdit and anything else are refused.
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const MAX_LINE = 1024 * 1024;

// The path as written, made absolute under the workspace. A path given through the workspace's other name (for
// example /tmp for /private/tmp on macOS) is read as the same place. Null when it is outside the workspace.
function lexical(target) {
  let file = path.resolve(cfg.root, target);
  for (const alias of cfg.aliases) {
    if (file === alias || file.startsWith(alias + path.sep)) file = cfg.root + file.slice(alias.length);
  }
  const rel = path.relative(cfg.root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

// True when no part of the path, from the workspace folder down, is a symlink (dangling ones included).
function noLinks(file) {
  let dir = cfg.root;
  for (const part of path.relative(cfg.root, file).split(path.sep)) {
    dir = path.join(dir, part);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (err) { if (err && err.code === 'ENOENT') return true; return false; }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function inside(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function decide(tool, input) {
  if (!WRITE_TOOLS.includes(tool)) return { behavior: 'deny', message: tool + ' is not allowed while applying this update; only the accepted files may be written.' };
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string' || 'notebook_path' in input) {
    return { behavior: 'deny', message: 'A write while applying must name exactly one file in file_path.' };
  }
  const file = lexical(input.file_path);
  if (!file) return { behavior: 'deny', message: 'Outside the workspace: ' + input.file_path };
  if (!noLinks(file)) return { behavior: 'deny', message: 'A symlink is on the way to this file, so it may lead elsewhere: ' + path.relative(cfg.root, file) };
  if (cfg.allowed.includes(file) || inside(cfg.update_dir, file)) return { behavior: 'allow', updatedInput: input };
  return { behavior: 'deny', message: 'Not a change you accepted in this update: ' + path.relative(cfg.root, file) };
}

function log(entry) {
  try {
    const fd = fs.openSync(cfg.log, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
    try { fs.writeSync(fd, JSON.stringify(entry) + '\n'); } finally { fs.closeSync(fd); }
  } catch {}
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function error(id, code, message) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); }

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.length > MAX_LINE) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return;
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: (req.params && req.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gtd-gate', version: '1' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'approve', description: 'Answers Claude Code\'s permission questions while a context update is applied.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] } }] } });
  } else if (req.method === 'tools/call') {
    const params = req.params && typeof req.params === 'object' ? req.params : {};
    if (params.name !== 'approve') return error(req.id, -32602, 'Unknown tool');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const tool = typeof args.tool_name === 'string' ? args.tool_name : 'unknown';
    const decision = decide(tool, args.input);
    const target = args.input && typeof args.input.file_path === 'string' ? lexical(args.input.file_path) : null;
    log({ tool, file: target ? path.relative(cfg.root, target) : null, decision: decision.behavior });
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (typeof req.method === 'string' && req.method.startsWith('notifications/')) {
    // Notifications get no answer.
  } else {
    error(req.id, -32601, 'Method not found');
  }
});
`;

/** Throws unless no part of `file` below `root` is a symlink (dangling ones included). */
function assertNoLinks(root: string, file: string, what: string): void {
  let dir = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    dir = path.join(dir, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`${what} goes through a symlink (${path.relative(root, dir)}), so it may lead elsewhere; replace the link with a real folder or file first`), { statusCode: 409 });
  }
}

export interface ApprovalGate {
  /** The MCP configuration to pass with `--mcp-config`. */
  mcpConfig: string;
  /** One JSON line per decision. */
  log: string;
  /** The private folder holding all of it; removed with `removeApprovalGate` after the run. */
  dir: string;
}

/**
 * Prepares the gate for one apply run in a new private temporary folder: the script, its settings (the accepted
 * files and the update folder, as paths under the workspace folder) and the MCP configuration that starts it.
 * `targets` are workspace-relative paths, already checked; any symlink on the way to one of them is refused here.
 */
export async function writeApprovalGate(workspace: string, updateId: string, targets: string[]): Promise<ApprovalGate> {
  const root = await fsp.realpath(workspace);
  const updateDir = path.join(root, 'context-updates', updateId);
  assertNoLinks(root, updateDir, 'The update folder');
  const allowed = targets.map((t) => {
    const file = path.join(root, t);
    assertNoLinks(root, file, `The accepted file ${t}`);
    return file;
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-gate-'));
  await fsp.chmod(dir, 0o700).catch(() => {});
  const script = path.join(dir, 'approval-gate.cjs');
  const config = path.join(dir, 'gate.json');
  const log = path.join(dir, 'gate.log');
  const mcpConfig = path.join(dir, 'mcp.json');
  // A new private folder: these names cannot exist yet, so 'wx' never follows anything.
  const create = (file: string, content: string) => fsp.writeFile(file, content, { flag: 'wx', mode: 0o600 });
  await create(script, SCRIPT);
  const aliases = [...new Set([path.resolve(workspace)])].filter((a) => a !== root);
  await create(config, JSON.stringify({ root, aliases, update_dir: updateDir, allowed, log }, null, 2) + '\n');
  await create(log, '');
  // The dashboard's own Node runs the gate; in the desktop app that is Electron, told to behave as Node.
  await create(mcpConfig, JSON.stringify({ mcpServers: { gtd_gate: { command: process.execPath, args: [script, config], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2) + '\n');
  return { mcpConfig, log, dir };
}

/** Removes a gate's private folder after its run. */
export async function removeApprovalGate(gate: ApprovalGate): Promise<void> {
  await fsp.rm(gate.dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * What the gate decided during a run: files it allowed and refused (workspace-relative), and other actions it
 * refused by tool name (for example Bash, which the apply command uses to clean up; the dashboard does that).
 * Permission decisions only: an allowed write is not proof that the file was written.
 */
export async function readGateLog(log: string): Promise<{ allowed: string[]; refused: string[]; refused_actions: string[] }> {
  const lines = (await fsp.readFile(log, 'utf-8').catch(() => '')).split('\n').filter(Boolean);
  const allowed = new Set<string>();
  const refused = new Set<string>();
  const actions = new Set<string>();
  for (const line of lines) {
    try {
      const d = JSON.parse(line) as { tool?: string; file?: string | null; decision?: string };
      if (d.file) (d.decision === 'allow' ? allowed : refused).add(d.file);
      else if (d.decision !== 'allow') actions.add(d.tool ?? 'unknown');
    } catch { /* a partial line */ }
  }
  return { allowed: [...allowed], refused: [...refused], refused_actions: [...actions] };
}
