# HTTP API reference

The dashboard talks to a small local API. AI agents and your own scripts can use the same
API. This page lists every route in `server/src/routes/`, plus the health check and the
live event stream defined in `server/src/index.ts`.

All examples use the fictional demo workspace from `scripts/seed-demo.mjs` (Northwind Labs,
Alex Morgan and colleagues). Responses are shortened with `…` where they are long.

## Basics

- **Address.** The server listens on `http://127.0.0.1:3001` only. Set `PORT` to change the
  port. `gtd start` and `npm run dev` both start it.
- **Local requests only.** Every request must use the host `127.0.0.1:<port>` or
  `localhost:<port>`. A request with another `Host`, a foreign `Origin` or
  `Sec-Fetch-Site: cross-site` gets `403 Forbidden`. This protects against DNS rebinding
  and browser form posts from other sites.
- **No authentication.** Anything that can reach the loopback port can use the API, so do
  not expose it through a proxy or tunnel.
- **JSON in, JSON out.** Send `Content-Type: application/json`. Bodies can be up to 10 MB.
  File uploads use `multipart/form-data` with a single field called `file` (50 MB maximum).
- **Partial updates.** `PUT` and `PATCH` routes merge the fields you send into the existing
  record. Fields you leave out keep their value.
- **Workspace.** Routes work on the workspace the server is currently pointed at (see
  [Workspace](#workspace)). Only the setup routes work before one is selected.
- **Paths in responses.** Many records include a `path` with the file's absolute location
  on disk. The examples below use `/Users/alex/gtd-demo` as the workspace folder.

### Errors

Errors come back as JSON with an HTTP status code:

```json
{ "error": "Error", "message": "Task not found: TASK-2099-9999" }
```

| Status | When |
|---|---|
| `400` | Invalid input (a bad id, a missing field, a path that leaves the workspace) |
| `403` | The request is not a trusted local request |
| `404` | The record or route does not exist |
| `409` | A conflict, for example a record that already exists |
| `413` | An upload over the 50 MB limit |
| `500` | An unexpected server error. The message is generic; details are in the server log |

A few routes return a simpler `{ "error": "…" }` body. They are noted below.

### Contents

- [Health and live events](#health-and-live-events)
- [Tasks](#tasks)
- [Stakeholders](#stakeholders)
- [Org charts](#org-charts)
- [Context notes](#context-notes)
- [Context updates](#context-updates)
- [Output templates](#output-templates)
- [Agents and skills](#agents-and-skills)
- [Profile](#profile)
- [Situation, insights and agent activity](#situation-insights-and-agent-activity)
- [Search and mentions](#search-and-mentions)
- [Kaizen](#kaizen)
- [Routines](#routines)
- [Workspace](#workspace)
- [First-run setup](#first-run-setup)

---

## Health and live events

| Method | Path | What it does |
|---|---|---|
| `GET` | `/health` | Checks that the server is up |
| `GET` | `/api/events` | Server-sent events: one `file_change` event each time a workspace file changes |

```text
GET /health
→ 200 {"status":"ok","timestamp":"2026-10-28T09:00:00.000Z"}

GET /api/events
→ 200 text/event-stream
  event: connected
  data: {"timestamp":"2026-10-28T09:00:00.000Z"}

  event: file_change
  data: {"type":"change","path":"tasks/active/TASK-2026-0001/task.md","timestamp":"2026-10-28T09:01:00.000Z"}
```

The stream sends a comment line every 30 seconds to keep the connection open.

---

## Tasks

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/tasks` | List active tasks. Optional filters: `status`, `priority`, `tags` (comma-separated), `stakeholder_ref`, `search` |
| `POST` | `/api/tasks` | Create a task. Returns `201` with the new task and its generated id |
| `GET` | `/api/tasks/:id` | Get one task's frontmatter |
| `PUT` | `/api/tasks/:id` | Update a task's fields |
| `DELETE` | `/api/tasks/:id` | Delete the task folder and everything in it. Returns `204` |
| `POST` | `/api/tasks/:id/archive` | Move the task to `tasks/archive/` and set its status to `archived` |
| `GET` | `/api/tasks/:id/content` | Get the Markdown body of `task.md` |
| `PUT` | `/api/tasks/:id/content` | Replace the Markdown body. Body: `{ "content": "…" }` |
| `POST` | `/api/tasks/:id/execution-package` | Build and save an execution package for an agent. Returns `201` |
| `GET` | `/api/tasks/:id/execution-package/preview` | Preview the files and size of the package without saving it |
| `GET` | `/api/tasks/:id/files` | List the files attached to the task |
| `POST` | `/api/tasks/:id/files` | Upload a file to the task (multipart, field `file`). Returns `201` |
| `DELETE` | `/api/tasks/:id/files/:filename` | Delete one attached file. Returns `204` |

Task statuses are `backlog`, `ready`, `in_progress`, `blocked`, `review`, `in_review`,
`approved`, `done` and `archived`. Priorities are `critical`, `high`, `medium` and `low`.

```text
GET /api/tasks?status=in_progress
→ 200 [{"id":"TASK-2026-0001","title":"Board update: Q3 operations review","status":"in_progress",
        "priority":"critical","due_date":"2026-10-30","stakeholder_refs":["STK-0001","STK-0005"],
        "deliverables":[{"id":"D1","format":"pptx","template_ref":"OUT-executive-deck",
        "status":"in_progress","file_path":"deliverables/q3-board-update.pptx"}, …], …}]

POST /api/tasks
{"title":"Draft the Q4 hiring plan","priority":"medium","due_date":"2026-11-14",
 "stakeholders":[{"ref":"STK-0002","role":"approver"}],
 "deliverables":[{"format":"md","template_ref":"OUT-plain-text"}]}
→ 201 {"id":"TASK-2026-0152","title":"Draft the Q4 hiring plan","status":"backlog","priority":"medium",
       "due_date":"2026-11-14","stakeholder_refs":["STK-0002"],
       "path":"/Users/alex/gtd-demo/tasks/active/TASK-2026-0152/task.md", …}

GET /api/tasks/TASK-2026-0001
→ 200 {"id":"TASK-2026-0001","title":"Board update: Q3 operations review","status":"in_progress", …}

PUT /api/tasks/TASK-2026-0152
{"status":"in_progress"}
→ 200 {"id":"TASK-2026-0152","status":"in_progress","updated_at":"2026-10-28T09:05:00.000Z", …}

DELETE /api/tasks/TASK-2026-0152
→ 204 (no body)

POST /api/tasks/TASK-2026-0007/archive
→ 200 {"message":"Task TASK-2026-0007 archived"}

GET /api/tasks/TASK-2026-0001/content
→ 200 {"content":"Ten-slide deck on Q3 delivery, cost and the FY27 plan."}

PUT /api/tasks/TASK-2026-0001/content
{"content":"Ten-slide deck on Q3 delivery, cost and the FY27 plan.\n\nOpen with the answer."}
→ 200 {"message":"Content updated"}

POST /api/tasks/TASK-2026-0001/execution-package
{"includeStakeholders":true,"includeContext":true,"includeProfile":true,"includeTemplate":true}
→ 201 {"id":"28ec2f40-…","task_id":"TASK-2026-0001","files":[…],"skills":[…],"permissions":{…},
       "command":"claude …","total_size_bytes":5120,"saved_path":"/Users/alex/gtd-demo/…"}

GET /api/tasks/TASK-2026-0001/execution-package/preview
→ 200 {"estimatedTokens":1002,"files":[{"path":"/Users/alex/gtd-demo/tasks/active/TASK-2026-0001/task.md",
        "type":"task","size":1023,"hash":"64ed1f…"}],"command":"claude …"}

GET /api/tasks/TASK-2026-0001/files
→ 200 [{"name":"notes.txt","size":3,"modified":"2026-10-28T09:10:00.000Z","type":"txt"}]

POST /api/tasks/TASK-2026-0001/files   (multipart: file=@notes.txt)
→ 201 {"name":"notes.txt","size":3,"modified":"2026-10-28T09:10:00.000Z","type":"txt"}

DELETE /api/tasks/TASK-2026-0001/files/notes.txt
→ 204 (no body)
```

The execution package options all default to `true`. You can also pass
`selectedContextIds` and `selectedStakeholderRefs` to limit what goes in.

---

## Stakeholders

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/stakeholders` | List stakeholders. Optional `type=people` or `type=groups` |
| `POST` | `/api/stakeholders` | Create a stakeholder. Returns `201` |
| `GET` | `/api/stakeholders/:id` | Get one stakeholder |
| `PUT` | `/api/stakeholders/:id` | Update a stakeholder's fields |
| `DELETE` | `/api/stakeholders/:id` | Delete a stakeholder and remove them from every org chart. Returns `204` |

```text
GET /api/stakeholders?type=people
→ 200 [{"id":"STK-0004","name":"Daniel Okafor","role":"Head of Logistics","organization":"Northwind Labs",
        "influence":"executor","what_matters":"Clear priorities and realistic deadlines.", …}, …]

POST /api/stakeholders
{"name":"Jordan Lee","role":"Finance Business Partner","organization":"Northwind Labs","influence":"influencer"}
→ 201 {"id":"STK-0007","name":"Jordan Lee","role":"Finance Business Partner", …}

GET /api/stakeholders/STK-0004
→ 200 {"id":"STK-0004","name":"Daniel Okafor","role":"Head of Logistics", …}

PUT /api/stakeholders/STK-0004
{"what_matters":"Clear priorities, realistic deadlines and early warning on volume."}
→ 200 {"id":"STK-0004","what_matters":"Clear priorities, realistic deadlines and early warning on volume.", …}

DELETE /api/stakeholders/STK-0007
→ 204 (no body)
```

---

## Org charts

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/org-charts` | List every chart. With `?stakeholder=STK-0001`, return that person's position in each chart instead |
| `POST` | `/api/org-charts` | Create a chart. Returns `201` |
| `GET` | `/api/org-charts/:id` | Get one chart |
| `PUT` | `/api/org-charts/:id` | Update a chart's name, description, members or units |
| `DELETE` | `/api/org-charts/:id` | Delete a chart (the stakeholders stay). Returns `204` |

```text
GET /api/org-charts
→ 200 [{"id":"ORG-0001","name":"Northwind Labs leadership","organization":"Northwind Labs",
        "members":[{"ref":"STK-0001"},{"ref":"STK-0002","reports_to":"STK-0001"}, …], …}]

POST /api/org-charts
{"name":"Logistics team","organization":"Northwind Labs","members":[{"ref":"STK-0004"}]}
→ 201 {"id":"ORG-0002","name":"Logistics team","members":[{"ref":"STK-0004"}], …}

GET /api/org-charts/ORG-0001
→ 200 {"id":"ORG-0001","name":"Northwind Labs leadership", …}

PUT /api/org-charts/ORG-0002
{"description":"Daniel's direct reports"}
→ 200 {"id":"ORG-0002","description":"Daniel's direct reports", …}

DELETE /api/org-charts/ORG-0002
→ 204 (no body)
```

---

## Context notes

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/context` | List context notes. Optional `category` |
| `POST` | `/api/context` | Create a note. Returns `201` |
| `GET` | `/api/context/:id` | Get one note with its body |
| `PUT` | `/api/context/:id` | Update a note. Changing `category` moves its folder |
| `DELETE` | `/api/context/:id` | Delete a note and its folder. Returns `204` |
| `GET` | `/api/context/:id/files` | List the note's attachments |
| `POST` | `/api/context/:id/files` | Upload an attachment (multipart, field `file`). Returns `201` |
| `GET` | `/api/context/:id/archive` | Download the note's folder (note and attachments) as a ZIP |
| `GET` | `/api/context/:id/files/<path>` | Open an attachment in the browser. Add `?download=1` to save it. The path may include subfolders |
| `DELETE` | `/api/context/:id/files/:filename` | Delete one attachment. Returns `204` |

Categories are `company`, `organization`, `strategy`, `programs`, `decisions`, `risks`,
`glossary` and `situation`.

```text
GET /api/context?category=risks
→ 200 [{"id":"CTX-single-freight-carrier-dependency","category":"risks",
        "title":"Single freight carrier dependency", "body":"…", …}]

POST /api/context
{"category":"glossary","title":"OTIF","body":"On time, in full. Share of orders delivered complete by the promised date."}
→ 201 {"id":"CTX-otif","category":"glossary","title":"OTIF","slug":"otif", …}

GET /api/context/CTX-operations-org-chart
→ 200 {"id":"CTX-operations-org-chart","category":"organization","title":"Operations org chart",
       "body":"Logistics, Customer Success and Procurement report to the COO.", …}

PUT /api/context/CTX-otif
{"body":"On time, in full. Target for FY27 is 96%."}
→ 200 {"id":"CTX-otif","body":"On time, in full. Target for FY27 is 96%.", …}

DELETE /api/context/CTX-otif
→ 204 (no body)

GET /api/context/CTX-operations-org-chart/files
→ 200 [{"name":"org-chart.pdf","size":48211,"modified":"2026-10-28T09:00:00.000Z","type":"pdf"}]

POST /api/context/CTX-operations-org-chart/files   (multipart: file=@org-chart.pdf)
→ 201 {"name":"org-chart.pdf","size":48211,"modified":"2026-10-28T09:00:00.000Z","type":"pdf"}

GET /api/context/CTX-operations-org-chart/archive
→ 200 application/zip (operations-org-chart.zip)

GET /api/context/CTX-operations-org-chart/files/org-chart.pdf?download=1
→ 200 application/pdf (as an attachment)

DELETE /api/context/CTX-operations-org-chart/files/org-chart.pdf
→ 204 (no body)
```

---

## Context updates

A context update collects new material (a transcript, notes, slides), gets proposals from
an agent and applies them to the context notes after review. The agent commands make some
state changes by editing `update.md`; the routes below are the ones the dashboard makes.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/context-updates` | List context updates |
| `POST` | `/api/context-updates` | Create an update. Body: `title`, `source_date`, `notes`, `text` (all optional). Returns `201` |
| `GET` | `/api/context-updates/:id` | Get one update with its proposals, and the current and proposed content |
| `PATCH` | `/api/context-updates/:id` | Edit `title`, `source_date` or `notes` |
| `DELETE` | `/api/context-updates/:id` | Delete an update. Returns `204` |
| `POST` | `/api/context-updates/:id/materials` | Upload material (multipart, field `file`). Returns `201`. For a WebVTT transcript the response names the readable copy written next to it (`transcript`, `transcript_complete`), or says why none was made (`transcript_problem`); the copy is also recorded in the update's `transcripts`. `409` when the same file is already in the update |
| `GET` | `/api/context-updates/:id/materials/<name>` | Open material in the browser. Add `?download=1` to save it |
| `DELETE` | `/api/context-updates/:id/materials/:name` | Delete one piece of material. A readable transcript copy recorded for it goes too, unless it was changed. Returns `204` |
| `PUT` | `/api/context-updates/:id/keep-materials` | Keep the material after the update is done, or release it. Body: `{ "keep": true }` |
| `PUT` | `/api/context-updates/:id/decisions` | Save review decisions on proposals: `accepted`, `rejected` or `null`, with an optional `reviewer_note` |
| `PUT` | `/api/context-updates/:id/meeting-records` | From `in_review`: confirm or reject meeting records, apart from the proposals. Body: `{ "records": { "M-01": { "confirmation": "confirmed", "revision": "<the record's revision>" } } }`, each `confirmed`, `rejected` or `null`. Returns `409` when the record changed since it was loaded, and `400` for a record with `problems` (it can only be rejected) or a duplicate id |
| `POST` | `/api/context-updates/:id/meeting-records/:recordId/tasks` | From `done`: create a task from an action item of a confirmed record and link the item to it, in one step. Body: `{ "item": 0, "revision": "<the record's revision>", "task": { ...the fields of POST /api/tasks } }` (`item` counts the items the record shows, from 0). Returns `201` with `{ task, update, created: true }`, or `200` with the task the item already has. `409` when the record is not confirmed or changed since it was loaded |
| `GET` | `/api/context-updates/:id/run` | The current or last run started from the dashboard (`command`: `analyze` or `apply`), or `null` |
| `POST` | `/api/context-updates/:id/run` | Body `{ "command": "analyze" }` from `ready`, or `{ "command": "apply" }` from `approved`: run `/gtd-context-analyze <id>` or `/gtd-context-apply <id>` with the installed AI tool, without a window. An apply runs with an approval step that allows writes only to the accepted files and the update's own folder. Returns `202` with the run. `409` when another run is going, the update is not in the right status, nothing accepted writes a file, or the tool is not installed or signed in; `400` for another command |
| `POST` | `/api/context-updates/:id/run/cancel` | Stop the run of this update, with everything it started. While a run is going the update cannot be edited, reopened, closed, approved or deleted (`409`) |
| `GET` | `/api/runner` | The AI tool that runs commands for the dashboard, checked for the current workspace: `installed`, `logged_in`, and `problems` (`not_installed`, `not_logged_in`, `not_subscription`, `auth_unknown`, `workspace_auth`, `not_trusted`), each with a plain message |
| `POST` | `/api/context-updates/:id/approve` | From `in_review`: approve the accepted proposals so an agent can apply them. Needs at least one accepted proposal or one confirmed meeting record. Records not confirmed are rejected. With no file to write (only removals or meeting records), the update is `done` at once. Returns `409` when a record changed after it was confirmed |
| `POST` | `/api/context-updates/:id/back-to-review` | From `approved`: back to `in_review`, before the apply has started |
| `POST` | `/api/context-updates/:id/reopen` | From `analyzing`, `in_review` or `approved`: back to `ready` to add material. The proposals and meeting records, also confirmed ones, are discarded |
| `POST` | `/api/context-updates/:id/close` | From `in_review` or `approved`: finish without changing any context note. Confirmed meeting records stay; `409` when one changed after it was confirmed |

A state change from the wrong status returns `409`, for example
`Cannot close while the update is "ready"`.

```text
GET /api/context-updates
→ 200 [{"id":"CU-2026-0001","title":"Weekly logistics sync","status":"in_review","source_date":"2026-10-27",
        "materials":[{"name":"pasted-text.md","size":263,"type":"md"}],"keep_materials":false,
        "proposals":[{"id":"P-01","action":"update", …}], …}]

POST /api/context-updates
{"title":"Logistics sync","source_date":"2026-10-28","text":"Carrier B contract signed."}
→ 201 {"id":"CU-2026-0002","title":"Logistics sync","status":"ready","source_date":"2026-10-28",
       "materials":[{"name":"pasted-text.md","size":26,"type":"md"}],"proposals":[], …}

GET /api/context-updates/CU-2026-0001
→ 200 {"id":"CU-2026-0001","status":"in_review","proposals":[{"id":"P-01","action":"update", …}], …}

PATCH /api/context-updates/CU-2026-0002
{"notes":"Sofia ran the meeting."}
→ 200 {"id":"CU-2026-0002","notes":"Sofia ran the meeting.", …}

DELETE /api/context-updates/CU-2026-0002
→ 204 (no body)

POST /api/context-updates/CU-2026-0002/materials   (multipart: file=@sync-notes.md)
→ 201 {"name":"sync-notes.md","size":812,"type":"md"}

GET /api/context-updates/CU-2026-0002/materials/sync-notes.md
→ 200 text/markdown

DELETE /api/context-updates/CU-2026-0002/materials/sync-notes.md
→ 204 (no body)

PUT /api/context-updates/CU-2026-0001/keep-materials
{"keep":true}
→ 200 {"id":"CU-2026-0001","keep_materials":true, …}

PUT /api/context-updates/CU-2026-0001/decisions
{"decisions":{"P-01":{"decision":"accepted","reviewer_note":"Correct, the contract is signed."}}}
→ 200 {"id":"CU-2026-0001","proposals":[{"id":"P-01","decision":"accepted", …}], …}

PUT /api/context-updates/CU-2026-0001/meeting-records
{"records":{"M-01":{"confirmation":"confirmed","revision":"3f9c1a7b2e4d6f80"}}}
→ 200 {"id":"CU-2026-0001","meeting_records":[{"id":"M-01","confirmation":"confirmed", …}], …}

POST /api/context-updates/CU-2026-0001/approve
→ 200 {"id":"CU-2026-0001","status":"approved", …}

POST /api/context-updates/CU-2026-0001/back-to-review
→ 200 {"id":"CU-2026-0001","status":"in_review", …}

POST /api/context-updates/CU-2026-0001/reopen
→ 200 {"id":"CU-2026-0001","status":"ready","proposals":[], …}

POST /api/context-updates/CU-2026-0001/close
→ 200 {"id":"CU-2026-0001","status":"done", …}
```

---

## Output templates

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/outputs/templates` | List output templates |
| `POST` | `/api/outputs/templates` | Create a template. Returns `201` |
| `GET` | `/api/outputs/templates/:id` | Get one template |
| `PUT` | `/api/outputs/templates/:id` | Update a template's fields |
| `DELETE` | `/api/outputs/templates/:id` | Delete a template. Returns `204` |
| `GET` | `/api/outputs/templates/:id/files` | List the template's files (examples, masters) |
| `POST` | `/api/outputs/templates/:id/files` | Upload a file (multipart, field `file`). Returns `201` |
| `GET` | `/api/outputs/templates/:id/archive` | Download the template folder as a ZIP |
| `GET` | `/api/outputs/templates/:id/files/<path>` | Open a template file. Add `?download=1` to save it. The path may include subfolders |
| `DELETE` | `/api/outputs/templates/:id/files/:filename` | Delete one file. Returns `204` |

```text
GET /api/outputs/templates
→ 200 [{"id":"OUT-executive-deck","name":"Executive deck","format":"pptx",
        "description":"A slide deck for an executive or board audience",
        "required_sections":["Title","Executive summary","Situation","Options","Recommendation","Next steps"], …}, …]

POST /api/outputs/templates
{"name":"Weekly ops summary","format":"md","required_sections":["Headline","Numbers","Risks","Asks"]}
→ 201 {"id":"OUT-weekly-ops-summary","name":"Weekly ops summary","format":"md", …}

GET /api/outputs/templates/OUT-executive-deck
→ 200 {"id":"OUT-executive-deck","name":"Executive deck","style_guide":"- One idea per slide. …", …}

PUT /api/outputs/templates/OUT-weekly-ops-summary
{"description":"Friday summary for the CEO"}
→ 200 {"id":"OUT-weekly-ops-summary","description":"Friday summary for the CEO", …}

DELETE /api/outputs/templates/OUT-weekly-ops-summary
→ 204 (no body)

GET /api/outputs/templates/OUT-executive-deck/files
→ 200 [{"name":"master.pptx","size":182044,"modified":"2026-10-28T09:00:00.000Z","type":"pptx"}]

POST /api/outputs/templates/OUT-executive-deck/files   (multipart: file=@master.pptx)
→ 201 {"name":"master.pptx","size":182044,"modified":"2026-10-28T09:00:00.000Z","type":"pptx"}

GET /api/outputs/templates/OUT-executive-deck/archive
→ 200 application/zip (executive-deck.zip)

GET /api/outputs/templates/OUT-executive-deck/files/master.pptx?download=1
→ 200 application/vnd.openxmlformats-officedocument.presentationml.presentation

DELETE /api/outputs/templates/OUT-executive-deck/files/master.pptx
→ 204 (no body)
```

---

## Agents and skills

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/agents` | List the agents defined in the workspace and globally |
| `GET` | `/api/agents/:name` | Get one agent |
| `GET` | `/api/skills` | List installed skills |
| `GET` | `/api/skills/marketplace` | List skills available to install. Returns `502` if the marketplace cannot be reached |
| `POST` | `/api/skills/install` | Install a skill from the marketplace. Body: `{ "slug": "…" }` |
| `GET` | `/api/skills/:name` | Get one skill |
| `DELETE` | `/api/skills/:name` | Delete an installed skill |

The marketplace, install and delete routes return `{ "error": "…" }` on failure.

```text
GET /api/agents
→ 200 [{"name":"context-researcher","description":"Updates and enriches context notes …",
        "scope":"workspace","tools":["Read","Write","WebSearch"],"validation_state":"valid", …}, …]

GET /api/agents/context-researcher
→ 200 {"name":"context-researcher","scope":"workspace","raw_content":"---\nname: context-researcher\n…", …}

GET /api/skills
→ 200 [{"name":"decision-brief","scope":"workspace","version":"1.0",
        "description":"Framework for writing one-page executive decision briefs. …","file_count":1, …}, …]

GET /api/skills/marketplace
→ 200 [{"slug":"meeting-notes","name":"meeting-notes","description":"…"}, …]

POST /api/skills/install
{"slug":"meeting-notes"}
→ 200 {"ok":true}

GET /api/skills/decision-brief
→ 200 {"name":"decision-brief","version":"1.0","raw_content":"---\nname: decision-brief\n…", …}

DELETE /api/skills/meeting-notes
→ 200 {"ok":true}
```

---

## Profile

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/profile` | Get the executive profile |
| `PUT` | `/api/profile` | Update profile fields |

```text
GET /api/profile
→ 200 {"name":"Alex Morgan","role":"Chief Operating Officer","organization":"Northwind Labs",
       "communication_style":"Direct. Lead with the ask, then the numbers. One page whenever possible.", …}

PUT /api/profile
{"principles":"Customers first. Bad news early. Small experiments before big bets."}
→ 200 {"name":"Alex Morgan","principles":"Customers first. Bad news early. Small experiments before big bets.", …}
```

---

## Situation, insights and agent activity

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/situation` | The Situation screen: counts, what needs attention, current focus, upcoming work, recent activity |
| `GET` | `/api/insights` | Insights for a window: `days=7`, `30` (default), `90` or `all` |
| `GET` | `/api/insights/calendar` | Activity per day for the same windows. Returns `400` for any other `days` value |
| `GET` | `/api/insights/calendar/day/:date` | Details for one day (`YYYY-MM-DD`). Returns `400` for an invalid date |
| `GET` | `/api/agent-activity` | Pile sizes and work in progress, used by the Agent Floor |

The insights routes return `{ "error": "…" }` on failure.

```text
GET /api/situation
→ 200 {"overdue_count":0,"due_soon_count":4,"blocked_count":1,"in_progress_count":1,
       "attention_queue":[{"id":"TASK-2026-0004","title":"Churn deep dive: enterprise accounts",
       "reason":"blocked","due_date":"2026-11-03","priority":"high", …}],
       "current_focus":[…],"upcoming_commitments":[…],"recent_activity":[…],"workflow_snapshot":{…}}

GET /api/insights?days=30
→ 200 {"window_days":30,"summary":{"completed":6,"open":8,"overdue":0,"median_turnaround_hours":30,
       "first_pass_rate":1, …},"attention":[…],"by_stakeholder":[…],"by_output":[…],"weekly":[…], …}

GET /api/insights/calendar?days=7
→ 200 {"from":"2026-10-22","to":"2026-10-28","today":"2026-10-28","window_days":7,
       "days":[{"date":"2026-10-22","created":1,"completed":0,"activity":1,
       "top_tasks":[{"id":"TASK-2026-0002","title":"Decision brief: second freight carrier"}], …}, …]}

GET /api/insights/calendar/day/2026-10-22
→ 200 {"date":"2026-10-22","totals":{"created":1,"completed":0,"runs":0,"due":0,"overdue":0,"activity":1},
       "tasks":[{"id":"TASK-2026-0002","title":"Decision brief: second freight carrier","events":["created"], …}],
       "stakeholders":[{"ref":"STK-0004","name":"Daniel Okafor","count":1}, …], …}

GET /api/agent-activity
→ 200 {"counts":{"backlog":4,"active":2,"review":1,"done":7},
       "tasks":[{"id":"TASK-2026-0001","pile":"active","status":"in_progress", …}, …], …}
```

---

## Search and mentions

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/search` | Full-text search. `q` is required; `types` limits the result types (comma-separated, for example `task,context`) |
| `GET` | `/api/mentions` | Suggestions for the `@` picker in a task's objective. `q` and `limit` (1 to 50, default 8) |
| `GET` | `/api/mentions/resolve` | Check that a mentioned file still exists. `href` is the link to check |

```text
GET /api/search?q=carrier
→ 200 {"query":"carrier","count":2,"results":[
        {"id":"CTX-single-freight-carrier-dependency","type":"context","title":"Single freight carrier dependency", …},
        {"id":"TASK-2026-0002","type":"task","title":"Decision brief: second freight carrier","status":"in_review", …}]}

GET /api/mentions?q=pri&limit=2
→ 200 [{"type":"stakeholder","id":"STK-0001","label":"Priya Natarajan",
        "detail":"Chief Executive Officer · Northwind Labs","href":"/stakeholders/people/stk-0001.md"},
       {"type":"task","id":"TASK-2026-0004","label":"Churn deep dive: enterprise accounts",
        "detail":"blocked","href":"/tasks/active/TASK-2026-0004/task.md"}]

GET /api/mentions/resolve?href=/stakeholders/people/stk-0001.md
→ 200 {"exists":true}
```

---

## Kaizen

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/kaizen` | List improvement proposals |
| `GET` | `/api/kaizen/:id` | Get one proposal. Returns `404` with `{ "error": "Not found" }` if it does not exist |
| `PATCH` | `/api/kaizen/:id` | Set `status` (`proposed`, `applied` or `rejected`) and `applied_at`; invalid values return 400. A transition to `rejected` stamps `rejected_at` for retention |

```text
GET /api/kaizen
→ 200 [{"id":"KZN-001","title":"Always add a one-line answer before the board deck","status":"proposed",
        "area":"profile","files_affected":["profile/executive-profile.md"], …}]

GET /api/kaizen/KZN-001
→ 200 {"id":"KZN-001","root_cause":"Two board decks came back asking for the bottom line first.", …}

PATCH /api/kaizen/KZN-001
{"status":"applied","applied_at":"2026-10-28"}
→ 200 {"id":"KZN-001","status":"applied","applied_at":"2026-10-28", …}
```

---

## Routines

Routines create tasks on a schedule. The built-in System cleanup job lives under the same
prefix.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/routines` | List routines with their next run |
| `GET` | `/api/routines/history` | Recent runs. `limit` from 1 to 300 (default 50) |
| `POST` | `/api/routines/preview` | Describe a schedule and list its next runs. Nothing is saved |
| `POST` | `/api/routines/run-due` | Create the tasks that are due now (what the timer does) |
| `GET` | `/api/routines/system-cleanup` | The System cleanup job: settings, schedule and last run |
| `PUT` | `/api/routines/system-cleanup` | Update System cleanup settings |
| `POST` | `/api/routines/system-cleanup/preview` | What a cleanup run would do now. Optional `settings` to try. Nothing changes |
| `POST` | `/api/routines/system-cleanup/run` | Run System cleanup now. Returns `201` |
| `POST` | `/api/routines` | Create a routine: `title`, `schedule`, `task`, and optionally `enabled` and `catch_up`. Returns `201` |
| `GET` | `/api/routines/:id` | Get one routine |
| `PATCH` | `/api/routines/:id` | Update any of the create fields |
| `DELETE` | `/api/routines/:id` | Delete a routine. Tasks it already created stay. Returns `204` |
| `POST` | `/api/routines/:id/run` | Create the routine's task now. Returns `201` |

```text
GET /api/routines
→ 200 [{"id":"RT-0001","title":"Weekly ops summary","enabled":true,"summary":"Every Friday at 15:00",
        "next_run_at":"2026-11-06T06:00:00.000Z", …}]

GET /api/routines/history?limit=2
→ 200 [{"routine_id":"RT-0001","routine_title":"Weekly ops summary","trigger":"manual",
        "at":"2026-10-28T09:20:00.000Z","status":"ok","created":["TASK-2026-0153"],
        "message":"Created TASK-2026-0153.", …}]

POST /api/routines/preview
{"schedule":{"frequency":"weekly","interval":1,"weekdays":["fri"],"time":"15:00","starts_on":"2026-11-06"}}
→ 200 {"summary":"Every Friday at 15:00","next_runs":[{"at":"2026-11-06T06:00:00.000Z","due_date":"2026-11-06"}, …]}

POST /api/routines/run-due
→ 200 []

GET /api/routines/system-cleanup
→ 200 {"id":"SYSTEM-CLEANUP","title":"System cleanup","settings":{"enabled":true,
       "schedule":{"frequency":"weekly","weekdays":["mon"],"time":"09:00", …},
       "memory_review":{"enabled":true,"stale_after_days":180},"rules":{…}, …}, …}

PUT /api/routines/system-cleanup
{"memory_review":{"enabled":true,"stale_after_days":120}}
→ 200 {"id":"SYSTEM-CLEANUP","settings":{"memory_review":{"enabled":true,"stale_after_days":120}, …}, …}

POST /api/routines/system-cleanup/preview
{}
→ 200 {"plan":{"items":[],"counts":{"completed_tasks":0,"archived_tasks":0,"context_updates":0,"kaizen":0,"trash":0},
       "deferred":0},"memory":{"notes":4,"stakeholders":6,"duplicates":[],"stale":[],"thin":[], …},"open_review":null}

POST /api/routines/system-cleanup/run
→ 201 {"routine_id":"SYSTEM-CLEANUP","trigger":"manual","status":"ok","message":"…","context_update":…, …}

POST /api/routines
{"title":"Weekly ops summary",
 "schedule":{"frequency":"weekly","interval":1,"weekdays":["fri"],"time":"15:00","starts_on":"2026-11-06"},
 "task":{"title":"Weekly ops summary","priority":"medium"}}
→ 201 {"id":"RT-0001","title":"Weekly ops summary","enabled":true,"catch_up":"latest",
       "summary":"Every Friday at 15:00","next_run_at":"2026-11-06T06:00:00.000Z", …}

GET /api/routines/RT-0001
→ 200 {"id":"RT-0001","title":"Weekly ops summary", …}

PATCH /api/routines/RT-0001
{"enabled":false}
→ 200 {"id":"RT-0001","enabled":false, …}

DELETE /api/routines/RT-0001
→ 204 (no body)

POST /api/routines/RT-0001/run
→ 201 {"routine_id":"RT-0001","trigger":"manual","status":"ok","created":["TASK-2026-0153"],
       "message":"Created TASK-2026-0153.", …}
```

`schedule.starts_on` is required, as `YYYY-MM-DD`. Without it the server returns
`400` with `Invalid schedule.starts_on: use YYYY-MM-DD`.

---

## Workspace

The setup routes (`init`, `switch`, `recent`, `pick-folder`) also work before a workspace
is selected.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/workspace` | The current workspace: path, name, settings and whether it is a git repository |
| `PUT` | `/api/workspace` | Rename the workspace. Body: `{ "name": "…" }` |
| `POST` | `/api/workspace/init` | Create a workspace in an existing folder. Body: `path`. Returns `201` |
| `POST` | `/api/workspace/switch` | Point the app at another folder. Returns `409` with `needs_init: true` if it is not a workspace yet; send `initialize: true` to create one |
| `GET` | `/api/workspace/recent` | Workspaces opened on this machine |
| `POST` | `/api/workspace/recent/forget` | Remove a folder from that list (the folder stays on disk). Body: `path` |
| `POST` | `/api/workspace/pick-folder` | Open the system folder picker on the machine running the server. Returns `{ "path": null }` on cancel and `501` where there is no picker |
| `POST` | `/api/workspace/reinitialize` | Re-run the scaffold on the current workspace to add missing files |
| `POST` | `/api/workspace/open` | Open the workspace folder in Finder, Explorer or the file manager |
| `POST` | `/api/workspace/open-claude` | Open Claude Code in a new terminal window at the workspace |
| `GET` | `/api/workspace/validate` | Validate every workspace file against its schema |
| `GET` | `/api/workspace/validation/count` | The number of validation errors and warnings |
| `GET` | `/api/workspace/git/status` | Git status of the workspace |
| `GET` | `/api/workspace/git/diff` | Git diff. Optional `file` for a single file |
| `GET` | `/api/workspace/git/log` | Recent commits. Optional `limit` (default 20) |
| `POST` | `/api/workspace/git/stage` | Stage one file. Body: `{ "file": "…" }` |
| `POST` | `/api/workspace/git/commit` | Commit what is staged. Body: `{ "message": "…" }` |
| `GET` | `/api/workspace/git/enabled` | Whether git features are usable (`git_enabled`: a repository and git installed) and whether git is installed (`git_installed`) |
| `GET` | `/api/workspace/files/<path>` | Serve any file inside the workspace. Add `?download=1` to save it. Paths that leave the workspace are refused |

`switch`, `recent/forget`, `pick-folder`, `open` and `open-claude` return
`{ "error": "…" }` on failure.

Git is optional. When no git program is installed, `git_enabled` and `is_repo` are
`false` and `git_installed` is `false`, even if the workspace has a `.git` folder.
`git/diff`, `git/log`, `git/stage` and `git/commit` then answer
`503 {"error":"Git not available","message":"Git is not installed on this computer. …"}`.

```text
GET /api/workspace
→ 200 {"path":"/Users/alex/gtd-demo","name":"Executive Workspace","git_enabled":false,"git_installed":true,
       "schema_versions":{"task":"1.0","stakeholder":"1.0", …}}

PUT /api/workspace
{"name":"Northwind ops"}
→ 200 {"path":"/Users/alex/gtd-demo","name":"Northwind ops", …}

POST /api/workspace/init
{"path":"/Users/alex/gtd-demo"}
→ 201 {"message":"Workspace initialized","config":{"path":"/Users/alex/gtd-demo", …}}

POST /api/workspace/switch
{"path":"~/Documents/new-folder"}
→ 409 {"error":"This folder is not a Get Things Done workspace yet.","needs_init":true,
       "path":"/Users/alex/Documents/new-folder"}

POST /api/workspace/switch
{"path":"~/Documents/new-folder","initialize":true}
→ 200 {"message":"Workspace changed","initialized":true,"config":{"path":"/Users/alex/Documents/new-folder", …}}

GET /api/workspace/recent
→ 200 [{"path":"/Users/alex/gtd-demo","name":"Executive Workspace","current":true,"available":true,
        "last_opened":"2026-10-28T09:00:00.000Z"}]

POST /api/workspace/recent/forget
{"path":"/Users/alex/Documents/new-folder"}
→ 200 [{"path":"/Users/alex/gtd-demo","current":true, …}]

POST /api/workspace/pick-folder
→ 200 {"path":"/Users/alex/gtd-demo"}

POST /api/workspace/reinitialize
→ 200 {"message":"Workspace re-initialized","config":{…}}

POST /api/workspace/open
→ 200 {"opened":true}

POST /api/workspace/open-claude
→ 200 {"opened":true,"command":"cd \"/Users/alex/gtd-demo\" && claude"}

GET /api/workspace/validate
→ 200 [{"level":"info","rule":"workspace","message":"Workspace validation passed with no issues"}]

GET /api/workspace/validation/count
→ 200 {"errors":0,"warnings":0}

GET /api/workspace/git/status
→ 200 {"is_repo":true,"branch":"main","modified":["profile/executive-profile.md"],"staged":[],
       "untracked":[],"ahead":0,"behind":0,"is_clean":false,"git_installed":true}

GET /api/workspace/git/diff?file=profile/executive-profile.md
→ 200 {"files":["profile/executive-profile.md"],"diff":"diff --git a/profile/executive-profile.md …",
       "stats":{"insertions":1,"deletions":1,"files_changed":1}}

GET /api/workspace/git/log?limit=5
→ 200 [{"hash":"3f2a9c1…","author":"Alex Morgan","date":"2026-10-28T09:30:00+01:00","message":"Update profile"}, …]

POST /api/workspace/git/stage
{"file":"profile/executive-profile.md"}
→ 200 {"message":"Staged: profile/executive-profile.md"}

POST /api/workspace/git/commit
{"message":"Update profile"}
→ 200 {"message":"Committed successfully"}

GET /api/workspace/git/enabled
→ 200 {"git_enabled":true,"git_installed":true}

GET /api/workspace/files/tasks/active/TASK-2026-0001/deliverables/speaker-notes.md
→ 200 text/markdown
```

## First-run setup

The dashboard shows a setup screen instead of its pages until a workspace is open. These two
routes let it create or open one without `gtd init`. They work before any workspace exists.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/setup` | Whether a workspace is open, a suggested folder for a new one, the recent workspaces that still exist, and which AI assistants are installed |
| `POST` | `/api/setup` | Create a workspace in a folder, or open the workspace already there |

`POST /api/setup` body:

| Field | Type | Notes |
| --- | --- | --- |
| `path` | string | Required. `~` is expanded |
| `create` | boolean | Create the folder when it does not exist. Without it a missing folder is a `400` |
| `require_existing` | boolean | Only open an existing workspace: a plain folder answers `409` with `needs_init: true` and creates nothing |
| `workspace_name` | string | Optional, at most 120 characters, one line. Default "Executive Workspace" |
| `profile` | object | Optional `name`, `role`, `organization`, each at most 120 characters, one line |
| `ai_tools` | string[] | Any of `claude-code`, `copilot`, `codex`. The workspace gets agent instructions for these only |

An existing workspace is opened as it is: its profile and agent files are never changed. AI
assistants are detected by looking for their programs on `PATH` and in the usual install folders
(Copilot also counts with VS Code); nothing is run.

```text
GET /api/setup
→ 200 {"configured":false,"workspace_path":null,
       "suggested_path":"/Users/alex/Documents/Get Things Done","suggested_path_is_workspace":false,
       "recent":[],
       "ai_tools":[{"id":"claude-code","label":"Claude Code","description":"…","installed":true,
                    "install_url":"https://claude.com/product/claude-code"}, …]}

POST /api/setup
{"path":"~/Documents/Get Things Done","create":true,"workspace_name":"Executive Workspace",
 "profile":{"name":"Alex Morgan","role":"COO","organization":"Northwind Labs"},"ai_tools":["claude-code"]}
→ 201 {"initialized":true,"config":{"path":"/Users/alex/Documents/Get Things Done","name":"Executive Workspace", …}}

POST /api/setup
{"path":"~/Downloads","require_existing":true}
→ 409 {"error":"This folder is not a Get Things Done workspace yet.","needs_init":true,"path":"/Users/alex/Downloads"}
```

