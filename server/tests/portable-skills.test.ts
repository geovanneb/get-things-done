import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readManifest, scaffoldWorkspace, upgradeWorkspace, type AiTool } from '../src/services/scaffold';
import { parseMarkdown } from '../src/utils/markdown';

const profile = { name: 'Alex Morgan', role: 'COO', organization: 'Northwind Labs' };
const claudeTemplates = path.join(__dirname, '..', '..', 'templates', 'ai', 'claude-code', '.claude');

async function workspace(t: { after: (fn: () => Promise<void>) => void }, aiTools: AiTool[]) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-portable-skills-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  scaffoldWorkspace(dir, { profile, aiTools });
  return dir;
}

/** Every procedure, specialist and skill Claude Code has, by name. */
function claudeNames(): string[] {
  const md = (dir: string) => fs.readdirSync(path.join(claudeTemplates, dir)).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));
  const skills = fs.readdirSync(path.join(claudeTemplates, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  return [...md('commands'), ...md('agents'), ...skills].sort();
}

const skillsIn = (dir: string) => fs.readdirSync(path.join(dir, '.agents', 'skills')).sort();

for (const tool of ['codex', 'copilot'] as const) {
  test(`a ${tool} workspace gets every Claude Code procedure, specialist and skill as an Agent Skill`, async (t) => {
    const dir = await workspace(t, [tool]);
    assert.deepEqual(skillsIn(dir), claudeNames());
    for (const name of skillsIn(dir)) {
      const raw = await fsp.readFile(path.join(dir, '.agents', 'skills', name, 'SKILL.md'), 'utf8');
      const { data, content } = parseMarkdown(raw);
      // The Agent Skills standard: a name that matches the folder and a description, nothing a stricter tool refuses.
      assert.deepEqual(Object.keys(data).sort(), ['description', 'name'], name);
      assert.equal(data['name'], name);
      assert.ok(typeof data['description'] === 'string' && data['description'].length > 20, name);
      assert.doesNotMatch(data['description'] as string, /\/gtd-/, `${name}: no slash command only Claude Code has`);
      assert.ok(content.trim().length > 200, `${name} keeps its body`);
    }
  });
}

test('the procedures say how to read the Claude Code wording, and keep every step', async (t) => {
  const dir = await workspace(t, ['codex']);
  const skill = await fsp.readFile(path.join(dir, '.agents', 'skills', 'gtd-task', 'SKILL.md'), 'utf8');
  assert.match(skill, /`\$ARGUMENTS` is the ID the executive named/);
  assert.match(skill, /Execute task TASK-2026-0001/);
  const command = parseMarkdown(await fsp.readFile(path.join(claudeTemplates, 'commands', 'gtd-task.md'), 'utf8')).content.trim();
  assert.ok(skill.includes(command), 'the whole procedure, unchanged');
});

test('a Claude Code workspace gets no .agents folder; a workspace with both tools gets one copy', async (t) => {
  assert.equal(fs.existsSync(path.join(await workspace(t, ['claude-code']), '.agents')), false);
  const both = await workspace(t, ['codex', 'copilot']);
  const paths = readManifest(both)!.files.map((f) => f.path);
  assert.equal(paths.length, new Set(paths).size, 'each file listed once');
  assert.deepEqual(skillsIn(both), claudeNames());
});

test('an existing Codex workspace gets the skills on its next refresh, and an edited one is kept', async (t) => {
  const dir = await workspace(t, ['codex']);
  await fsp.rm(path.join(dir, '.agents'), { recursive: true });
  const added = upgradeWorkspace(dir, { profile, aiTools: ['codex'] }).added;
  assert.ok(added.includes(path.join('.agents', 'skills', 'gtd-task', 'SKILL.md')), 'added');

  const file = path.join(dir, '.agents', 'skills', 'risk-analysis', 'SKILL.md');
  await fsp.appendFile(file, '\nMy own rule.\n');
  const again = upgradeWorkspace(dir, { profile, aiTools: ['codex'] });
  assert.ok(again.conflicted.includes(path.join('.agents', 'skills', 'risk-analysis', 'SKILL.md')));
  assert.match(await fsp.readFile(file, 'utf8'), /My own rule\./);
});
