import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Task, Stakeholder, ValidationResult } from '../types';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { MentionService } from './mentionService';
import { OrgChartService, findLoop, findUnitLoop } from './orgChartService';
import { OutputService } from './outputService';
import { isDone, isOpen } from './taskStatus';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const mentionService = new MentionService();
const orgChartService = new OrgChartService();
const outputService = new OutputService();

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const taskSchema = {
  type: 'object',
  required: ['id', 'title', 'status', 'priority'],
  properties: {
    id: { type: 'string', pattern: '^TASK-\\d{4}-\\d{4}$' },
    title: { type: 'string', minLength: 1 },
    // Every status the app itself writes or reads (see TaskStatus). `in_review` is what agents set when
    // they finish; `approved` is the legacy spelling of Done that older workspaces still carry.
    status: {
      type: 'string',
      enum: ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'in_review', 'approved', 'done', 'archived'],
    },
    priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    due_date: { type: 'string', format: 'date' },
    // stampStatusDates() and the workspace rules write full ISO timestamps; plain dates are still accepted.
    start_date: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
    done_date: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const stakeholderSchema = {
  type: 'object',
  required: ['id', 'name', 'influence'],
  properties: {
    // People are STK-NNNN, groups GRP-NNNN (see StakeholderService.generateId).
    id: { type: 'string', pattern: '^(STK|GRP)-\\d{4}$' },
    name: { type: 'string', minLength: 1 },
    influence: { type: 'string', enum: ['decision_maker', 'influencer', 'informed', 'executor', 'sponsor'] },
    email: { type: 'string', format: 'email' },
  },
};

const validateTask = ajv.compile(taskSchema);
const validateStakeholder = ajv.compile(stakeholderSchema);

export class ValidationService {
  validateTask(task: Task): ValidationResult[] {
    const results: ValidationResult[] = [];

    // AJV schema validation
    const valid = validateTask(task);
    if (!valid && validateTask.errors) {
      for (const err of validateTask.errors) {
        results.push({
          level: 'error',
          rule: 'schema',
          message: err.message || 'Schema validation failed',
          path: err.instancePath || undefined,
        });
      }
    }

    // Required fields check
    if (!task.title || task.title.trim().length === 0) {
      results.push({ level: 'error', rule: 'required_fields', message: 'Task title is required', path: 'title' });
    }

    // Date logic checks
    if (task.due_date && task.start_date) {
      // Compare calendar days: due_date is a date, start_date is usually a timestamp, and a task
      // started on its due day is not late.
      if (task.due_date.slice(0, 10) < task.start_date.slice(0, 10)) {
        results.push({ level: 'error', rule: 'date_logic', message: 'due_date must be after start_date', path: 'due_date' });
      }
    }

    if (task.done_date && !isDone(task.status) && task.status !== 'archived') {
      results.push({ level: 'warning', rule: 'date_logic', message: 'Task has done_date but status is not done or archived', path: 'done_date' });
    }

    if (isDone(task.status) && !task.done_date) {
      results.push({ level: 'info', rule: 'best_practice', message: 'Completed task should have a done_date', path: 'done_date' });
    }

    // Overdue check
    if (task.due_date && isOpen(task.status)) {
      // Compare calendar days in local time: `new Date('2026-10-21')` is midnight UTC, which made every
      // task "overdue" on its own due date.
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      if (task.due_date.slice(0, 10) < today) {
        results.push({ level: 'warning', rule: 'overdue', message: `Task is overdue since ${task.due_date}`, path: 'due_date' });
      }
    }

    return results;
  }

  validateStakeholder(stk: Stakeholder): ValidationResult[] {
    const results: ValidationResult[] = [];

    const valid = validateStakeholder(stk);
    if (!valid && validateStakeholder.errors) {
      for (const err of validateStakeholder.errors) {
        results.push({
          level: 'error',
          rule: 'schema',
          message: err.message || 'Schema validation failed',
          path: err.instancePath || undefined,
        });
      }
    }

    if (!stk.name || stk.name.trim().length === 0) {
      results.push({ level: 'error', rule: 'required_fields', message: 'Stakeholder name is required', path: 'name' });
    }

    return results;
  }

  async validateWorkspace(): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const seenIds = new Set<string>();

    // Validate all tasks
    let tasks: Task[] = [];
    try {
      tasks = await taskService.listTasks();
    } catch {
      results.push({ level: 'warning', rule: 'workspace', message: 'Could not read tasks directory' });
    }

    let stakeholders: Stakeholder[] = [];
    try {
      stakeholders = await stakeholderService.listStakeholders();
    } catch {
      results.push({ level: 'warning', rule: 'workspace', message: 'Could not read stakeholders directory' });
    }

    const stakeholderIds = new Set(stakeholders.map((s) => s.id));

    let templateIds = new Set<string>();
    try {
      const templates = await outputService.listTemplates();
      templateIds = new Set(templates.map((t) => t.id));
    } catch {
      // No templates yet
    }

    // Check tasks
    for (const task of tasks) {
      // Duplicate ID check
      if (seenIds.has(task.id)) {
        results.push({ level: 'error', rule: 'duplicate_id', message: `Duplicate task ID: ${task.id}`, path: task.path });
      }
      seenIds.add(task.id);

      // Validate task fields
      const taskResults = this.validateTask(task);
      results.push(...taskResults.map((r) => ({ ...r, path: `${task.id}: ${r.path || ''}` })));

      // Check stakeholder references
      for (const ref of task.stakeholder_refs || []) {
        if (!stakeholderIds.has(ref)) {
          results.push({ level: 'warning', rule: 'broken_ref', message: `Task ${task.id} references unknown stakeholder: ${ref}`, path: task.path });
        }
      }

      // Check template reference
      if (task.template_ref && !templateIds.has(task.template_ref)) {
        results.push({ level: 'warning', rule: 'broken_ref', message: `Task ${task.id} references unknown template: ${task.template_ref}`, path: task.path });
      }

      // Check @-mentions in the Objective still point at an existing file
      for (const m of mentionService.extractMentions(task.body)) {
        if (!(await mentionService.resolve(m.href))) {
          results.push({ level: 'warning', rule: 'broken_mention', message: `Task ${task.id} mentions a missing file: @${m.label} (${m.href})`, path: task.path });
        }
      }
    }

    // Check stakeholders
    const stkSeenIds = new Set<string>();
    for (const stk of stakeholders) {
      if (stkSeenIds.has(stk.id)) {
        results.push({ level: 'error', rule: 'duplicate_id', message: `Duplicate stakeholder ID: ${stk.id}`, path: stk.path });
      }
      stkSeenIds.add(stk.id);

      const stkResults = this.validateStakeholder(stk);
      results.push(...stkResults.map((r) => ({ ...r, path: `${stk.id}: ${r.path || ''}` })));
    }

    // Check org charts
    try {
      for (const chart of await orgChartService.listCharts()) {
        const refs = new Set<string>();
        for (const m of chart.members) {
          if (refs.has(m.ref)) {
            results.push({ level: 'warning', rule: 'duplicate_id', message: `Org chart ${chart.id} lists ${m.ref} more than once`, path: chart.path });
          }
          refs.add(m.ref);
          if (!stakeholderIds.has(m.ref)) {
            results.push({ level: 'warning', rule: 'broken_ref', message: `Org chart ${chart.id} references unknown stakeholder: ${m.ref}`, path: chart.path });
          }
        }
        for (const m of chart.members) {
          if (m.reports_to && !refs.has(m.reports_to)) {
            results.push({ level: 'warning', rule: 'broken_ref', message: `Org chart ${chart.id}: ${m.ref} reports to ${m.reports_to}, who is not in the chart`, path: chart.path });
          }
        }
        const loop = findLoop(chart.members);
        if (loop) {
          results.push({ level: 'error', rule: 'org_chart_loop', message: `Org chart ${chart.id} has a reporting loop: ${loop.join(' → ')}`, path: chart.path });
        }
        const unitIds = new Set((chart.units ?? []).map((u) => u.id));
        for (const u of chart.units ?? []) {
          if (u.parent && !unitIds.has(u.parent)) {
            results.push({ level: 'warning', rule: 'broken_ref', message: `Org chart ${chart.id}: unit ${u.id} sits in unknown unit ${u.parent}`, path: chart.path });
          }
          if (u.head && !refs.has(u.head)) {
            results.push({ level: 'warning', rule: 'broken_ref', message: `Org chart ${chart.id}: the head of unit ${u.id} (${u.head}) is not in the chart`, path: chart.path });
          }
        }
        for (const m of chart.members) {
          if (m.unit && !unitIds.has(m.unit)) {
            results.push({ level: 'warning', rule: 'broken_ref', message: `Org chart ${chart.id}: ${m.ref} belongs to unknown unit ${m.unit}`, path: chart.path });
          }
        }
        const unitLoop = findUnitLoop(chart.units ?? []);
        if (unitLoop) {
          results.push({ level: 'error', rule: 'org_chart_loop', message: `Org chart ${chart.id} has units nested in a loop: ${unitLoop.join(' → ')}`, path: chart.path });
        }
      }
    } catch {
      results.push({ level: 'warning', rule: 'workspace', message: 'Could not read org charts directory' });
    }

    if (results.length === 0) {
      results.push({ level: 'info', rule: 'workspace', message: 'Workspace validation passed with no issues' });
    }

    return results;
  }
}
