import * as fs from 'fs';
import * as path from 'path';
import { parseMarkdown } from '../utils/markdown';

/**
 * The workspace procedures for assistants other than Claude Code, as Agent Skills in `.agents/skills/`.
 *
 * Claude Code's files stay the one source: its commands (`/gtd-task`, `/gtd-context-analyze`, `/gtd-context-apply`),
 * its specialist agents and its skills are rendered here as `.agents/skills/<name>/SKILL.md`. Codex reads skills from
 * `.agents/skills`, and GitHub Copilot (CLI, VS Code agent mode, cloud agent) does too, so Codex and Copilot follow
 * the same procedures as Claude Code instead of the short summaries in their instruction files.
 */

/** The folder both Codex and Copilot read project skills from. */
export const PORTABLE_SKILLS_DIR = path.join('.agents', 'skills');

/** Turns a template's text into what the workspace gets. */
export type TemplateTransform = (content: string) => string;

/** A skill's other files (references, scripts) have no transform: they are copied as they are. */
export type PortableFile = [srcPath: string, relPath: string, transform?: TemplateTransform];

/** How the executive asks for each procedure in plain words, so the assistant picks the skill without a slash command. */
const COMMAND_TRIGGERS: Record<string, string> = {
  'gtd-task': 'Use when the executive asks to execute, run or work on a task by ID, for example "Execute task TASK-2026-0001".',
  'gtd-context-analyze': 'Use when the executive asks to analyze a context update by ID, for example "Analyze context update CU-2026-0001".',
  'gtd-context-apply': 'Use when the executive asks to apply a context update by ID, for example "Apply context update CU-2026-0001".',
};

/** A frontmatter value as a YAML double-quoted string: JSON's escaping is valid YAML. */
function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

/** Agent Skills keep `name` and `description` only: other tools may refuse a field they do not know. */
function skillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${yamlString(description)}\n---\n\n${body.replace(/^\n+/, '')}`;
}

function parts(content: string): { data: Record<string, unknown>; body: string } {
  const { data, content: body } = parseMarkdown(content);
  return { data: data as Record<string, unknown>, body };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** One of Claude Code's slash commands as a skill: the same steps, with the ID the executive named. */
export function commandToSkill(name: string): TemplateTransform {
  return (content) => {
    const { data, body } = parts(content);
    // "(e.g. /gtd-task TASK-2026-0001)": a slash command only Claude Code has.
    const summary = text(data['description']).replace(/\s*\(e\.g\.[^)]*\)/, '');
    const description = [summary.endsWith('.') ? summary : `${summary}.`, COMMAND_TRIGGERS[name] ?? ''].join(' ');
    const note = [
      '> How to read these steps outside Claude Code:',
      '> - `$ARGUMENTS` is the ID the executive named (for example `TASK-2026-0001` or `CU-2026-0001`).',
      '>   If they named none, ask for it and stop.',
      '> - A `/gtd-…` command named below is the skill of the same name in `.agents/skills/`.',
      '> - Where a step sends you to `CLAUDE.md` for a rule, the routing list or the confidentiality rules, read',
      '>   this workspace\'s own instructions instead: `AGENTS.md` for Codex, `.github/copilot-instructions.md` for',
      '>   Copilot. Lists of instruction files a Kaizen may change name every file as it is.',
      '> - A specialist agent named below (for example `executive-report-writer`) is the skill of that name: follow it.',
    ].join('\n');
    return skillFile(name, description, `${note}\n\n${body.replace(/^\n+/, '')}`);
  };
}

/** One of Claude Code's specialist agents as a skill: the same role and rules, for the assistant itself to follow. */
export function agentToSkill(name: string): TemplateTransform {
  return (content) => {
    const { data, body } = parts(content);
    const description = text(data['description']) || `The ${name} specialist.`;
    const note = `> Specialist role. A task with \`preferred_agent: ${name}\` is done in this role: follow it for the whole task.`;
    return skillFile(name, description, `${note}\n\n${body.replace(/^\n+/, '')}`);
  };
}

/** A Claude Code skill as an Agent Skill: the same body, with the standard frontmatter only. */
export function plainSkill(name: string): TemplateTransform {
  return (content) => {
    const { data, body } = parts(content);
    return skillFile(text(data['name']) || name, text(data['description']), body);
  };
}

function markdownNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

/**
 * Every portable skill file, from Claude Code's templates in `claudeTemplates` (`templates/ai/claude-code`). A skill's
 * other files (references, scripts) are copied as they are, under the same folder.
 */
export function portableSkillFiles(claudeTemplates: string): PortableFile[] {
  const source = path.join(claudeTemplates, '.claude');
  const out: PortableFile[] = [];
  const target = (name: string, file = 'SKILL.md') => path.join(PORTABLE_SKILLS_DIR, name, file);

  for (const name of markdownNames(path.join(source, 'commands'))) {
    out.push([path.join(source, 'commands', `${name}.md`), target(name), commandToSkill(name)]);
  }
  for (const name of markdownNames(path.join(source, 'agents'))) {
    out.push([path.join(source, 'agents', `${name}.md`), target(name), agentToSkill(name)]);
  }
  const skills = path.join(source, 'skills');
  if (fs.existsSync(skills)) {
    for (const entry of fs.readdirSync(skills, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const walk = (dir: string, rel: string): void => {
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
          const src = path.join(dir, file.name);
          const relFile = rel ? path.join(rel, file.name) : file.name;
          if (file.isDirectory()) walk(src, relFile);
          else if (file.isFile()) out.push(relFile === 'SKILL.md' ? [src, target(entry.name, relFile), plainSkill(entry.name)] : [src, target(entry.name, relFile)]);
        }
      };
      walk(path.join(skills, entry.name), '');
    }
  }
  return out;
}
