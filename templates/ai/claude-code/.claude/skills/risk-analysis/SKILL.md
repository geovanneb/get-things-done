---
name: risk-analysis
version: "1.0"
description: Structured framework for identifying, assessing, and communicating risks in executive deliverables. Use when a task involves a risk register, a risk section in a report, or a situation where risks need to be surfaced and prioritized for a senior audience.
tags: ["risk", "analysis", "executive", "governance"]
---

# Risk Analysis Skill

## When to use this skill

Use when the task requires identifying, categorizing, assessing, or communicating risks. This includes:
- Risk sections in quarterly reports or board updates
- Standalone risk registers or risk memos
- Decision briefs where risk comparison across options is needed
- Situation updates where emerging risks need to be surfaced

## Risk entry format

Every risk in a deliverable follows this structure:

```
Risk: [Short name — 3-6 words]
Category: Strategic | Operational | Financial | Regulatory | People | Reputational
Likelihood: High | Medium | Low
Impact: High | Medium | Low
Owner: [Name or function]
Status: Active | Mitigated | Monitoring | Closed
Description: [1-2 sentences — what the risk is and what triggers it]
Mitigation: [1-2 sentences — what is being done now]
Residual exposure: [What remains after mitigation]
```

## Priority matrix

Use this to determine which risks lead the section:

```
             Low Impact    Medium Impact    High Impact
High Prob    Monitor       Manage           Escalate immediately
Med Prob     Accept        Monitor          Manage actively
Low Prob     Accept        Accept           Monitor
```

**Escalate immediately**: Surface in executive summary, assign owner, set review date
**Manage actively**: Include in main risk section with mitigation detail
**Monitor**: List in risk register with quarterly review cadence
**Accept**: Acknowledge only if relevant to context

For executive deliverables: only include "Escalate" and "Manage" risks. Do not list accepted risks unless specifically requested.

## Risk categories defined

| Category | Includes |
|----------|---------|
| Strategic | Market shifts, competitive threats, strategic misalignment, M&A exposure |
| Operational | Process failures, system outages, supply chain, delivery risk |
| Financial | Liquidity, FX exposure, cost overruns, revenue shortfall |
| Regulatory | Compliance gaps, regulatory change, legal exposure |
| People | Key person dependency, talent risk, succession gaps, morale |
| Reputational | Media risk, client relationship risk, brand damage |

## Risk narrative for executive audiences

When writing risk content for a decision maker or board-level audience:

1. **Lead with the highest-priority risk** — do not bury critical exposure in item 5 of a list
2. **Quantify impact where possible** — "up to $3M revenue at risk" beats "significant financial impact"
3. **State what is being done** — a risk with no mitigation reads as negligence. If mitigation is insufficient, say so.
4. **Connect to strategy** — explain why this risk matters to the strategic priorities documented in the context library
5. **Avoid risk theater** — do not list 12 risks to appear thorough. Three well-analyzed risks beat a long list of obvious ones.

## Risk section template for reports

```markdown
## Risk Overview

[1 sentence: overall risk posture — improving, stable, or deteriorating, and why]

### Top Risks

**[Risk Name]** — [Category] — [Likelihood / Impact]
[Description and mitigation in 3-4 sentences. What is the exposure. What is being done. What remains.]

**[Risk Name]** — [Category] — [Likelihood / Impact]
[...]

### Changes Since Last Review
- [Risk that increased]: [why]
- [Risk that closed]: [why]
```

## Comparing risks across options (for decision briefs)

When a decision brief requires risk comparison:

| | Option A | Option B |
|---|---------|---------|
| Primary risk | [Risk name] | [Risk name] |
| Likelihood | High / Med / Low | High / Med / Low |
| Impact | High / Med / Low | High / Med / Low |
| Mitigation available | Yes / No / Partial | Yes / No / Partial |
| Residual exposure | [Description] | [Description] |

Call out asymmetric risks explicitly — if one option has a low-probability but catastrophic tail risk, name it even if the expected value looks acceptable.

## What to avoid

- **Risk inflation**: Not every uncertainty is a risk. A risk has a specific trigger, a probability, and a consequence. Avoid vague entries like "Market conditions may change."
- **Missing owners**: A risk without an owner is a risk no one will manage. Assign every active risk.
- **Stale risks**: If a risk is listed but has been effectively mitigated, close it. A risk register full of closed items that are not labeled as closed destroys credibility.
- **Fabricated estimates**: If likelihood and impact are not documented in context notes, label them as judgment-based: "(estimated)"
