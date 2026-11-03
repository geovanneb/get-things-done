# README positioning and launch notes — 0.9.0

## Positioning

**AI memory that grows with your work.** Record → review → remember → deliver.

Audience: people already using coding agents for work beyond code: developers coordinating projects, consultants, founders and project leads. The concrete problem is repeated explanation of decisions, people and expected output. The product connects meeting capture to reviewed context and then to deliverables. “AI memory” describes stored context, not training the model or independently verifying facts.

The README now makes this loop visible before the long reference material. It keeps installation, supported tools and privacy boundaries close to the value proposition. The previous technical reference is retained in [the user guide](user-guide.md), with corrected privacy/transcription statements. Real workspace filenames and shipped agent/template names still contain “executive”; the documentation does not pretend those interfaces were renamed.

## Research and resulting decisions

Reviewed 3 November 2026. These are primary sources and editorial judgments, not a controlled conversion experiment or a guarantee of stars.

| Source | Observation | Applied decision |
| --- | --- | --- |
| [GitHub: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) | A repository's first-read document should explain purpose, usefulness, getting started and help | Put the workflow and entry points first; move detailed reference out of the landing read |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | Its positioning emphasizes persistent AI context and Markdown ownership, with an MCP interface | “Local Markdown memory” is a category, not a unique claim. Explain our reviewed meeting-to-deliverable workflow; remove unsupported competitor checkboxes |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | Its positioning emphasizes private, on-device meeting capture and transcription | Offline transcription is useful proof, but explain what happens after transcription: reviewed work context and tasks |
| [GitHub: Topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics) | Topics help visitors discover repositories by purpose and subject | Recommend a focused set of relevant topics below; do not stuff the README with repeated keywords |
| [GitHub: Social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) | GitHub recommends a 1280×640 image below 1 MB | Include a ready-to-upload PNG and editable HTML source |
| [Project release page](https://github.com/geovanneb/get-things-done/releases) and local source at `1791fb8` | Recording/digests shipped in 0.8.0; meeting history and version work followed | Per the maintainer's release plan, this README targets 0.9.0 with the features on main |

Avoided unsupported promises: guaranteed one-shot work, absolute “nothing leaves your machine,” verified superiority over all memory tools, automatic truth, and runtime isolation for unpinned files. Claude Code's dashboard runner is distinct from Codex/Copilot file-based integration. Analysis and task output still need review; cloud tool use is governed by the provider's terms.

## Visual decisions and reproduction

Ten screenshots were captured from the actual current dashboard at 1440×900, all below 500 KB. They use only `seed-demo.mjs` data and fictional additions created by [the capture script](../scripts/readme-screenshots.mjs). The main transcript is a deliberately imported fictional WebVTT example. It is labeled as such; no recording, completed AI analysis, microphone capture or benchmark is fabricated.

The review proposal uses the existing seed fixture, which represents the state after analysis. The customer-update task is created through the API and does not pretend a deliverable has been generated. The source commit is `1791fb8`; the screenshots were made on macOS/Chromium.

Static images were chosen over a GIF: readers can inspect the transcript and review controls, and there is no looping motion or multi-megabyte animation. The earlier 40-second video remains linked and is identified as an earlier dashboard. Replace that video with a genuine 0.9.0 walkthrough when available.

```bash
npm run build
npm install --no-save playwright
npx playwright install chromium
node scripts/readme-screenshots.mjs
```

The capture script starts its own temporary HOME, workspace and loopback server. It cannot target an existing workspace. It removes the demo after capturing. Use the optional Playwright dependency only for capture; do not commit lockfile changes from installing it.

[Social preview PNG](images/social-preview.png) · [editable HTML](images/social-preview.html). To regenerate, open the HTML in Chromium at 1280×640, device scale 1, and capture the viewport. It embeds only the local screenshot.

## Suggested repository settings after merge

These are prepared recommendations; no GitHub settings or external posts were changed.

**About description:**

> Local-first AI work memory for Claude Code, Codex and Copilot. Record meetings, transcribe offline, review context updates and turn decisions into deliverables. Plain Markdown. MIT.

**Topics:** `ai-memory`, `local-first`, `claude-code`, `codex`, `github-copilot`, `ai-agents`, `meeting-notes`, `speech-to-text`, `offline`, `markdown`, `knowledge-management`, `task-management`, `productivity`.

**Social preview:** upload `docs/images/social-preview.png` through Settings → General → Social preview. A committed PNG does not set this automatically.

**Website field:** use the stable documentation or demo destination you want to maintain. Do not invent a separate landing page solely for this change.

## Launch and measurement

Use one honest demo: a fictional meeting introduces a changed deadline; review the proposed change; create a customer update using the revised context; review the deliverable. Include which parts are offline and which invoke the user's AI tool. Launch text can start with:

> I built an open-source work memory for coding agents. Record a meeting, transcribe it locally, review what should become context, then use it in the next task. The people, decisions and output templates are Markdown files you own.

Post where this workflow answers an actual question, following each community's rules. Invite people to try a small workspace and report missing context. Do not solicit reciprocal stars, automate unsolicited outreach or imply that a star guarantees updates.

Record a baseline before the release and compare equal windows after it: unique repository visitors, clones, stars per visitor, install-related issues and reported successful first runs. GitHub traffic and package downloads are imperfect proxies, not activation counts. Look for repeated setup friction and improve the first-run instructions before adding more promotion. The repository contains no new tracking code.

## Validation

- Application build and full `npm test` passed on the branch.
- Capture script completed all ten screenshots with no browser page errors.
- Screenshots visually inspected; image sizes and local Markdown links checked.
- No product behavior, templates, dependency declarations or lockfiles changed.
- The security/regression report from the separate review stays in the original checkout, outside this README branch.
