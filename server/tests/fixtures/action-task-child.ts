// A second dashboard for a test: makes a task from an action item in its own process, slowly, so two of them overlap.
// Arguments: <update id> <record id> <revision>. Prints the task id and whether it was created.
import { ContextUpdateService } from '../../src/services/contextUpdateService';
import { TaskService } from '../../src/services/taskService';

const [id, record, revision] = process.argv.slice(2) as [string, string, string];
const create = TaskService.prototype.createTask;
TaskService.prototype.createTask = async function (this: TaskService, ...args: Parameters<TaskService['createTask']>) {
  await new Promise((r) => setTimeout(r, 400));
  return create.apply(this, args);
};
new ContextUpdateService().createActionItemTask(id, record, { item: 0, revision, task: { title: 'Fictional task' } })
  .then((r) => { console.log(JSON.stringify({ task: r.task.id, created: r.created })); })
  .catch((err: Error) => { console.log(JSON.stringify({ error: err.message })); process.exitCode = 1; });
