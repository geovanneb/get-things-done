#!/usr/bin/env node
/**
 * Fill a running Get Things Done server with a fictional demo workspace.
 *
 * Everything here is made up: Northwind Labs, the people and the numbers.
 * It exists so contributors can see a populated dashboard and so the README
 * screenshots can be regenerated.
 *
 * Usage:
 *   gtd init -y -d /tmp/gtd-demo --name "Alex Morgan" --role COO --org "Northwind Labs"
 *   cd /tmp/gtd-demo && gtd start --no-open
 *   node scripts/seed-demo.mjs [http://127.0.0.1:3001]
 *
 * Never point this at a real workspace: it adds tasks and people to it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:3001').replace(/\/$/, '');
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (d, h = 9) => new Date(now - d * DAY + (h - 9) * 60 * 60 * 1000).toISOString();
const inDays = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const workspace = await api('GET', '/api/workspace');
const existing = await api('GET', '/api/tasks');
if (Array.isArray(existing) && existing.length > 0) {
  console.error(`Workspace ${workspace.path} already has tasks. Seed an empty demo workspace instead.`);
  process.exit(1);
}

await api('PUT', '/api/profile', {
  name: 'Alex Morgan',
  role: 'Chief Operating Officer',
  organization: 'Northwind Labs',
  responsibilities: 'Operations, supply chain, customer success and the yearly planning cycle.',
  communication_style: 'Direct. Lead with the ask, then the numbers. One page whenever possible.',
  decision_making: 'Data first, but I will decide with 70% of the information rather than wait.',
  language_preferences: 'English. Plain words, no jargon, no em dashes.',
  recurring_expectations: 'Every deliverable ends with a clear recommendation and the next three steps.',
  principles: 'Customers first. Bad news early. Small experiments before big bets.',
});

const people = [
  { name: 'Priya Natarajan', role: 'Chief Executive Officer', organization: 'Northwind Labs', influence: 'decision_maker', tags: ['leadership'], what_matters: 'Growth with healthy margins. Hates surprises.' },
  { name: 'Marcus Webb', role: 'Chief Financial Officer', organization: 'Northwind Labs', influence: 'decision_maker', tags: ['finance', 'leadership'], what_matters: 'Cash runway and predictable forecasts.' },
  { name: 'Sofia Lindqvist', role: 'VP Customer Success', organization: 'Northwind Labs', influence: 'influencer', tags: ['customers'], what_matters: 'Churn under 3%. Wants more support headcount.' },
  { name: 'Daniel Okafor', role: 'Head of Logistics', organization: 'Northwind Labs', influence: 'executor', tags: ['operations'], what_matters: 'Clear priorities and realistic deadlines.' },
  { name: 'Hana Sato', role: 'Board Member', organization: 'Bluefield Ventures', influence: 'influencer', tags: ['board'], what_matters: 'Governance, risk visibility, long-term strategy.' },
  { name: 'Leo Fischer', role: 'Partner Manager', organization: 'Contoso Freight', influence: 'informed', tags: ['partners'], what_matters: 'Volume commitments for next year.' },
];
const stk = {};
for (const p of people) {
  const created = await api('POST', '/api/stakeholders', { ...p, type: 'people' });
  stk[p.name.split(' ')[0]] = created.id;
}

const notes = [
  { category: 'strategy', title: 'FY27 operating plan', tags: ['planning'], body: 'Three bets for next year: regional warehouse, self-serve onboarding, support automation.' },
  { category: 'risks', title: 'Single freight carrier dependency', tags: ['supply-chain'], body: 'About 70% of outbound volume runs through one carrier. A second carrier is being evaluated.' },
  { category: 'decisions', title: 'Moved support tooling to one platform', tags: ['customers'], body: 'Decided in Q2. Consolidates three tools into one. Saves roughly $40k a year.' },
  { category: 'organization', title: 'Operations org chart', tags: ['people'], body: 'Logistics, Customer Success and Procurement report to the COO.' },
];
for (const n of notes) await api('POST', '/api/context', n);

const S = (key, role = 'audience', isKey = false) => ({ ref: stk[key], role, key: isKey });

// [title, status, priority, task_type, createdDaysAgo, doneDaysAgo|null, dueInDays|null, stakeholders, tags, objective]
const tasks = [
  ['Board update: Q3 operations review', 'in_progress', 'critical', 'presentation', 3, null, 2, [S('Priya', 'approver', true), S('Hana')], ['board'], 'Ten-slide deck on Q3 delivery, cost and the FY27 plan.'],
  ['Decision brief: second freight carrier', 'in_review', 'high', 'decision_brief', 6, null, 4, [S('Marcus', 'approver', true), S('Daniel', 'reviewer')], ['supply-chain'], 'Recommend whether to sign a second carrier before peak season.'],
  ['Support headcount request for Q1', 'ready', 'high', 'memo', 2, null, 9, [S('Marcus', 'approver', true), S('Sofia', 'reviewer')], ['customers'], 'Make the case for four additional support agents.'],
  ['Churn deep dive: enterprise accounts', 'blocked', 'high', 'analysis', 8, null, 6, [S('Sofia', 'reviewer', true)], ['customers'], 'Waiting on the renewal data export from finance.'],
  ['FY27 warehouse site shortlist', 'backlog', 'medium', 'strategy', 1, null, 30, [S('Daniel', 'reviewer'), S('Priya', 'approver', true)], ['planning'], 'Narrow five candidate regions down to two.'],
  ['Partner volume letter for Contoso Freight', 'backlog', 'low', 'memo', 1, null, 14, [S('Leo', 'audience', true)], ['partners'], 'Confirm next year volume ranges in writing.'],
  ['Weekly ops summary for the CEO', 'ready', 'medium', 'ad_hoc', 0, null, 1, [S('Priya', 'audience', true)], ['recurring'], 'One page: wins, risks, asks.'],
  ['Q2 quarterly operations report', 'done', 'high', 'quarterly_report', 40, 33, null, [S('Priya', 'approver', true), S('Marcus')], ['reporting'], 'Quarterly report for the leadership team.'],
  ['Vendor consolidation memo', 'done', 'medium', 'memo', 25, 24, null, [S('Marcus', 'approver', true)], ['procurement'], 'Summarise savings from consolidating vendors.'],
  ['Customer escalation playbook', 'done', 'medium', 'strategy', 20, 12, null, [S('Sofia', 'reviewer', true)], ['customers'], 'Clear steps for P1 customer escalations.'],
  ['Peak season staffing plan', 'done', 'high', 'analysis', 15, 14, null, [S('Daniel', 'reviewer', true)], ['operations'], 'Temporary staffing needs for November and December.'],
  ['Offsite agenda draft', 'done', 'low', 'ad_hoc', 9, 9, null, [S('Priya', 'audience')], ['leadership'], 'Two-day leadership offsite agenda.'],
  ['Cost-to-serve analysis by region', 'done', 'high', 'analysis', 18, 5, null, [S('Marcus', 'approver', true)], ['finance'], 'Where we lose money per order, by region.'],
  ['Thank-you note to the logistics team', 'done', 'low', 'memo', 4, 4, null, [S('Daniel', 'audience', true)], ['people'], 'Short note after the warehouse audit.'],
];

const deliverables = {
  'Board update: Q3 operations review': [
    { id: 'D1', format: 'pptx', template_ref: 'OUT-executive-deck', status: 'in_progress', file_path: 'deliverables/q3-board-update.pptx' },
    { id: 'D2', format: 'md', template_ref: 'OUT-plain-text', status: 'complete', file_path: 'deliverables/speaker-notes.md' },
  ],
  'Decision brief: second freight carrier': [
    { id: 'D1', format: 'docx', template_ref: 'OUT-executive-document', status: 'complete', file_path: 'deliverables/carrier-decision-brief.docx' },
  ],
};

for (const [title, status, priority, task_type, created, done, due, stakeholders, tags, objective] of tasks) {
  const t = await api('POST', '/api/tasks', {
    title, priority, tags, objective, stakeholders, description: objective,
    deliverables: deliverables[title] ?? [],
    due_date: due === null ? undefined : inDays(due),
  });
  const patch = { status, task_type, preferred_agent: 'executive-report-writer', created_at: daysAgo(created) };
  if (status !== 'backlog' && status !== 'ready') patch.start_date = daysAgo(created, 10);
  if (done !== null) patch.done_date = daysAgo(done, 15);
  await api('PUT', `/api/tasks/${t.id}`, patch);

  if (status === 'done' || status === 'in_review' || status === 'in_progress') {
    const dir = path.join(workspace.path, 'tasks', 'active', t.id, 'executions');
    fs.mkdirSync(dir, { recursive: true });
    const ran = new Date(done !== null ? now - done * DAY : now - DAY);
    const stamp = ran.toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.md`), `---\nagent: executive-report-writer\nstarted_at: '${ran.toISOString()}'\ncompleted_at: '${new Date(ran.getTime() + 25 * 60 * 1000).toISOString()}'\n---\n\nDrafted ${title.toLowerCase()}.\n`);
  }
}

const kaizenDir = path.join(workspace.path, 'kaizen');
fs.mkdirSync(kaizenDir, { recursive: true });
fs.writeFileSync(path.join(kaizenDir, 'KZN-001.md'), `---
schema_version: '1.0'
id: KZN-001
type: kaizen
title: Always add a one-line answer before the board deck
status: proposed
area: profile
root_cause: |
  Two board decks came back asking for the bottom line first.
proposed_fix: |
  Add "Open every deck with a one-line answer" to Recurring Expectations.
files_affected:
  - profile/executive-profile.md
created_at: '${daysAgo(2)}'
applied_at: null
---

Captured after the Q2 report review.
`);

console.log(`Seeded ${people.length} stakeholders, ${notes.length} context notes and ${tasks.length} tasks into ${workspace.path}`);
