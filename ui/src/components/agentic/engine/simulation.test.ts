/**
 * Headless check of the Agent Floor simulation. Drives a fake clock so whole
 * work cycles run in milliseconds, and asserts the two behaviours that were
 * wrong: counts must equal the snapshot, and a hand-in must only happen after
 * the task really changes status.
 */
let fakeNow = 0;
(globalThis as any).performance = { now: () => fakeNow };

import { createWorld, syncSnapshot, tick } from './simulation';
import { AgentActivitySnapshot, ActivityTask } from './activityTypes';

function task(id: string, pile: ActivityTask['pile'], status: string): ActivityTask {
  return {
    id, title: `Task ${id}`, pile, status, priority: 'high', agent: 'writer',
    updated_at: '', created_at: '', context_count: 2, stakeholder_count: 1,
    deliverables: [{ id: 'DEL-01', format: 'pptx', status: 'pending' }],
    execution_count: 0,
  };
}

function snap(counts: {backlog:number;active:number;review:number;done:number}, tasks: ActivityTask[]): AgentActivitySnapshot {
  return { generated_at: '', counts, tasks, recent_executions: [] };
}

function run(world: any, seconds: number, tasks: Map<string, ActivityTask>) {
  const stepMs = 50;
  for (let i = 0; i < (seconds * 1000) / stepMs; i++) {
    fakeNow += stepMs;
    tick(world, stepMs / 1000, tasks);
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// --- Scenario 1: one task genuinely in progress for a long time -------------
const world = createWorld();
const t1 = task('TASK-0001', 'active', 'in_progress');
const byId = new Map([[t1.id, t1]]);
syncSnapshot(world, snap({ backlog: 3, active: 1, review: 0, done: 5 }, [t1]));

let sawHandover = false;
let minBacklog = 99, maxReview = -1;
for (let s = 0; s < 24; s++) {
  run(world, 5, byId);
  if (world.agents.some((a: any) => a.stage === 'handover')) sawHandover = true;
  minBacklog = Math.min(minBacklog, world.piles.backlog.target);
  maxReview = Math.max(maxReview, world.piles.review.target);
}

check('counts stay exactly as reported while work is in progress',
  world.piles.backlog.target === 3 && world.piles.active.target === 1 &&
  world.piles.review.target === 0 && world.piles.done.target === 5,
  `backlog=${world.piles.backlog.target} active=${world.piles.active.target} review=${world.piles.review.target} done=${world.piles.done.target}`);
check('backlog count never drifts down during a work cycle', minBacklog === 3, `min=${minBacklog}`);
check('review count never rises without a status change', maxReview === 0, `max=${maxReview}`);
check('no hand-in while the task is still in progress', !sawHandover);
check('the agent stays on the floor and keeps working',
  world.agents.length === 1 && world.agents[0].stage === 'working',
  `stage=${world.agents[0]?.stage}`);

// --- Scenario 2: the task really moves to Needs Review ----------------------
const t2 = task('TASK-0001', 'review', 'in_review');
byId.set(t2.id, t2);
syncSnapshot(world, snap({ backlog: 3, active: 0, review: 1, done: 5 }, [t2]));
check('hand-in starts as soon as the status changes',
  world.agents[0]?.stage === 'handover' && world.agents[0]?.destination === 'review',
  `stage=${world.agents[0]?.stage} dest=${world.agents[0]?.destination}`);

run(world, 30, byId);
check('agent leaves the floor after handing in', world.agents.length === 0, `agents=${world.agents.length}`);
check('counts after hand-in match the snapshot',
  world.piles.active.target === 0 && world.piles.review.target === 1,
  `active=${world.piles.active.target} review=${world.piles.review.target}`);
check('the stack height caught up to the real count',
  Math.round(world.piles.review.shown) === 1, `shown=${world.piles.review.shown.toFixed(2)}`);

// --- Scenario 3: rework — the task comes back to In Progress ---------------
const world3 = createWorld();
const t3 = task('TASK-0002', 'active', 'in_progress');
const by3 = new Map([[t3.id, t3]]);
syncSnapshot(world3, snap({ backlog: 1, active: 1, review: 0, done: 0 }, [t3]));
run(world3, 20, by3);

const t3r = task('TASK-0002', 'review', 'in_review');
by3.set(t3r.id, t3r);
syncSnapshot(world3, snap({ backlog: 1, active: 0, review: 1, done: 0 }, [t3r]));
run(world3, 1, by3);

const t3b = task('TASK-0002', 'active', 'in_progress');
by3.set(t3b.id, t3b);
syncSnapshot(world3, snap({ backlog: 1, active: 1, review: 0, done: 0 }, [t3b]));
check('rework puts the agent back to work instead of letting it walk off',
  world3.agents.length === 1 && world3.agents[0].stage === 'working',
  `agents=${world3.agents.length} stage=${world3.agents[0]?.stage}`);
run(world3, 20, by3);
check('the resumed agent is still on the floor', world3.agents.length === 1);

// --- Scenario 4: blocked task ----------------------------------------------
const world4 = createWorld();
const t4 = task('TASK-0003', 'active', 'blocked');
const by4 = new Map([[t4.id, t4]]);
syncSnapshot(world4, snap({ backlog: 0, active: 1, review: 0, done: 0 }, [t4]));
run(world4, 25, by4);
check('a blocked task waits instead of miming research',
  world4.agents[0]?.blocked === true && world4.agents[0]?.activity === 'idle',
  `activity=${world4.agents[0]?.activity}`);

// --- Scenario 5: task sent back to the backlog -----------------------------
const world5 = createWorld();
const t5 = task('TASK-0004', 'active', 'in_progress');
const by5 = new Map([[t5.id, t5]]);
syncSnapshot(world5, snap({ backlog: 0, active: 1, review: 0, done: 0 }, [t5]));
run(world5, 10, by5);
const t5b = task('TASK-0004', 'backlog', 'backlog');
by5.set(t5b.id, t5b);
syncSnapshot(world5, snap({ backlog: 1, active: 0, review: 0, done: 0 }, [t5b]));
check('a task sent back to the backlog is not counted as handed in',
  world5.agents[0]?.stage === 'leaving', `stage=${world5.agents[0]?.stage}`);
run(world5, 20, by5);
check('review stays empty when work was pulled back',
  world5.piles.review.target === 0 && world5.agents.length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
