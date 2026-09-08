---
name: decision-brief
version: "1.0"
description: Framework for writing one-page executive decision briefs. Use when a task requires a decision to be made by a senior stakeholder and the output format is a concise, action-forcing document.
tags: ["decisions", "memos", "brief", "executive"]
---

# Decision Brief Skill

## When to use this skill

Use when the deliverable is a one-page document designed to get a decision from a senior stakeholder. Decision briefs are not status updates or reports — they are structured asks with a clear recommended path.

## The one-page constraint

A decision brief must fit on one page. If it does not fit, you are trying to include too much. Cut ruthlessly:
- One situation (not a history of the problem)
- One decision question (not a list of topics)
- Two or three options (not every conceivable alternative)
- One recommendation (not a list of considerations)
- One next step from the decision-maker

## Structure

```
DECISION BRIEF
Date: [Date]
To: [Recipient name and title]
From: [Sender]
Re: [Topic — max 10 words]
Confidentiality: [level]

SITUATION
[2-3 sentences: what has changed or what is at stake. No background, no history. 
Start with the present state, not the past.]

DECISION REQUIRED
[One specific question the recipient must answer.]
Deadline: [Date — and why this date matters]

OPTIONS
Option A — [Label]: [Description in 1-2 sentences]
  Upside: [...]   Risk: [...]   Cost/effort: [...]

Option B — [Label]: [Description in 1-2 sentences]
  Upside: [...]   Risk: [...]   Cost/effort: [...]

[Option C if genuinely distinct — do not add options to appear thorough]

RECOMMENDATION
[Option X] because [1-2 reasons tied specifically to this stakeholder's priorities and the current context].

NEXT STEP
Please confirm your decision by [date] so that [consequence — what becomes possible or what is avoided].
```

## Calibrating for the recipient

Before writing, read the stakeholder file. Anchor the recommendation in what is documented as important to them:
- If they prioritize speed: emphasize timeline implications
- If they prioritize risk mitigation: lead with downside protection
- If they prioritize team stability: address people implications explicitly
- If they value data: include a supporting number in the situation section

Do not write a generic brief and call it calibrated. The recommendation rationale must be specific to this person.

## Common mistakes

**Too many options**: Two options force a decision. Four options delay it. If you have more than three real options, collapse the least distinct ones.

**Weak recommendation**: "Either option could work depending on priorities" is not a recommendation. Take a position and defend it.

**Missing deadline**: A brief without a deadline is a request, not a decision. If the deadline is unclear, use the task's `due_date` and explain why that date is the constraint.

**Burying the ask**: The decision question must be explicit and early. Do not make the reader infer what you need from them.

**Option padding**: Every option listed must be genuinely viable. Do not include a "straw man" option that exists only to make the recommendation look better.

## When a decision is politically sensitive

If the decision involves competing stakeholder interests or is likely to be resisted:
1. Note the sensitivity in the situation section — acknowledge the tension
2. Recommend the approach that best serves the organization's documented priorities
3. Suggest a pre-brief with key influencers before sending (nemawashi, if relevant)
4. Make the cost of delay explicit — what happens if the decision is not made by the deadline
