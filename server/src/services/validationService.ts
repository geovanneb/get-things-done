import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Task, Stakeholder, ValidationResult } from '../types';
import { TaskService } from './taskService';
import { StakeholderService } from './stakeholderService';
import { OutputService } from './outputService';

const taskService = new TaskService();
const stakeholderService = new StakeholderService();
const outputService = new OutputService();

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const taskSchema = {
  type: 'object',
  required: ['id', 'title', 'status', 'priority'],
  properties: {
    id: { type: 'string', pattern: '^TASK-\\d{4}-\\d{4}$' },
    title: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'archived'] },
    priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    due_date: { type: 'string', format: 'date' },
    start_date: { type: 'string', format: 'date' },
    done_date: { type: 'string', format: 'date' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const stakeholderSchema = {
  type: 'object',
  required: ['id', 'name', 'influence'],
  properties: {
    id: { type: 'string', pattern: '^STK-\\d{4}$' },
    name: { type: 'string', minLength: 1 },
    influence: { type: 'string', enum: ['decision_maker', 'influencer', 'informed', 'executor'] },
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
      if (new Date(task.due_date) < new Date(task.start_date)) {
        results.push({ level: 'error', rule: 'date_logic', message: 'due_date must be after start_date', path: 'due_date' });
      }
    }

    if (task.done_date && task.status !== 'done' && task.status !== 'archived') {
      results.push({ level: 'warning', rule: 'date_logic', message: 'Task has done_date but status is not done or archived', path: 'done_date' });
    }

    if (task.status === 'done' && !task.done_date) {
      results.push({ level: 'info', rule: 'best_practice', message: 'Completed task should have a done_date', path: 'done_date' });
    }

    // Overdue check
    if (task.due_date && task.status !== 'done' && task.status !== 'archived') {
      const dueDate = new Date(task.due_date);
      if (dueDate < new Date()) {
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

    if (results.length === 0) {
      results.push({ level: 'info', rule: 'workspace', message: 'Workspace validation passed with no issues' });
    }

    return results;
  }
}
