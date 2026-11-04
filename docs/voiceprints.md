# Recognize known voices

Speakers come back week after week, but every transcript starts again at "Speaker 1, Speaker 2". With
**Recognize known voices** on, the app remembers a stakeholder's voice, **with that person's consent**, and
suggests their name the next time a transcription hears it. It runs fully offline with the speaker model the
app already downloads for **Tell speakers apart**. Design and discussion: issue #287.

The rule that shapes everything below: **a voice only ever suggests a name. It never names anyone.** A wrong
name is worse than none, because it would land quietly in records, tasks and deliverables.

## How it works for the user

1. **Settings > Transcription > Recognize known voices.** Off by default. It needs the speaker model and
   Tell speakers apart.
2. **Name a speaker with a stakeholder** (or yourself) as today. Next to the name, **Remember voice** asks
   for that person's consent: "Kim Park agreed that their voice is remembered on this computer…". Nothing is
   saved until the box is ticked.
3. **Later meetings** show "Sounds like Kim Park" next to the speaker, with **Use** (names them, through the
   same step as naming by hand) and **Not them** (hides the hint for that recording; nothing about the voice is
   learned from it).
4. Each later confirmation of a remembered person (naming them, or Use) adds that recording's speech to their
   voice, only the stretches that sound like them (each scoring 0.5 or more against the voice), so a speaker
   diarization merged with someone else does not mix that person in. Correcting or removing a name takes back
   what it added.
5. **The stakeholder's page is where a voice is managed**: its **Voice** section shows how it stands, the consent
   (the wording, who recorded it and when), and every sample with the meeting and speaker it came from. Remove one
   sample there (the last one forgets the voice, consent and all), or **Forget voice**. Settings lists every voice,
   linking each to its stakeholder, with **Forget all**; your own voice (`me`) is managed there. Deleting a stakeholder in the
   dashboard forgets their voice. A stakeholder deleted by editing files is never suggested again and stays
   listed in Settings, to be forgotten.

Stakeholders with a remembered voice carry a **Voice remembered** tag in the list and on their page.

## Where voices are kept

```
~/.gtd/voiceprints/<binding>/binding.json   the workspace folder these voices belong to
~/.gtd/voiceprints/<binding>/STK-0001.json  one person's voice
```

- **Outside the workspace.** `stakeholders/` goes to git and workspaces often sync to OneDrive or Dropbox: not
  acceptable for biometric data. Same precedent as the workspace picture.
- **Private.** Folders `0700`, files `0600`. Written with `atomicWrite`, one change at a time across dashboards
  (`.lock` in the binding).
- **Never part of anything else.** Not in `update.md`, the digest, the meeting sources, run packages, exports or
  search. Agents never see it. The API lists voices without their samples.
- **Each file holds** the speaker model's id and SHA-256 (a print made with another model is stale and never
  compared), the consent (wording version, the person, who recorded it and when), and up to 20 samples, each the
  mean embedding of one confirmed speaker of one recording, with where it came from (meeting, file or version,
  audio and transcript SHA-256, label, date).
- **Moving a workspace.** A binding is named after the folder's path. A moved workspace finds its voices under
  the old path; Settings offers **Use them here** only when the old folder is gone (a move) and this workspace
  remembers no voice yet. A copy never gets them by itself: it may hold other stakeholders under the same ids.
- **Backups.** System backups (Time Machine and the like) include `~/.gtd`, so a forgotten voice may still be in
  an older backup.

## Which speech is used

Transcript lines are not clean samples: each decoded part gets one speaker even with a minority second voice,
voices are renumbered as the transcript meets them, and the times are padded for recognition. So samples come
from the **diarizer's own turns**:

- the transcription job reports which diarized voice became which `Speaker N` (`labels`);
- a sample is a stretch where that voice speaks and no other sound of the diarization does, with 0.2 s taken off
  each edge, at least 1.5 s long, cut into pieces of at most 10 s, up to 60 s and 20 pieces per speaker
  (`cleanIntervals` in `server/src/services/transcription/voices.ts`);
- the recording stores these **times only** (`speaker_voices`), never a voice. Remembering a voice reads those
  stretches from the recording again (a format other than WAV is converted again to a temporary file).

A recording without audio (an imported transcript, or a meeting whose recording was not kept) cannot be used.

## Matching

`server/src/services/voiceprints/matching.ts`. For each speaker of a new transcript, the mean of its clean speech
is compared (cosine) with every usable remembered voice:

| Rule | Starting value |
|---|---|
| A suggestion needs at least this score | 0.70 |
| …and this lead over the second-best voice (judged before anything is assigned) | 0.15 |
| Someone the meeting did not expect needs at least | 0.85 |
| A remembered voice needs this much clean speech before it suggests anything | 10 s |
| A speaker needs this much clean speech to be compared | 3 s |
| …and at least this share of it, sample by sample, must score 0.5 or more with that person | 75% |

The expected people are the queued meeting's participants; for Transcribe again, the record's attendees and
speakers and anyone named in the meeting's versions. Your own voice (`me`) always counts as expected. Two labels
can get the same suggestion: diarization sometimes splits one person in two. The opposite also happens: diarization
can merge two people into one speaker, whose mean then half-resembles one of them. The last rule catches that: each
clean stretch is also scored on its own, and a speaker whose speech is not mostly that person gets no suggestion.

The voice means are computed in the worker only when the setting is on and at least one voice is remembered,
compared at once, and dropped. Only `speaker_suggestions` (`{ label, ref, score }`, the transcript's hash and the
speaker model's hash) are kept.

### Measured so far

With the real speaker model, sherpa-onnx-node 2.0.1 and synthetic macOS voices (fictional speech):

- the same voice, other sentences: 0.84 to 0.96; other voices: 0.09 to 0.66 (the closest pair, two US female
  voices, 0.63);
- the CI real-model test: a remembered voice found again in a two-voice recording at 1.00, the voice never
  remembered at 0.48;
- diarization (the existing speaker detection) can merge two voices into one speaker. In the desktop app, a
  remembered voice's own stretches scored 0.91 and 0.93 while a merged guest's scored 0.23 and 0.26 against it:
  the consistency rule withholds that suggestion. A voice remembered from such a speaker still mixes two people;
  check who a label really is before remembering it.

Synthetic voices are clean studio speech. **Calibrate on real meetings before changing the values**:
`node scripts/voiceprint-calibration.mjs <manifest.json>` runs locally and prints only score distributions.

## The two confirm paths

- **A recording in the queue**: `PUT /api/meeting-queue/:id/recordings/:file/speakers` as before, and the
  suggestion actions under `/api/voiceprints/suggestions/…`, all under the queue lock.
- **A Transcribe again version of a kept meeting** (`meetingVersions.ts`): its speakers belong to that version
  (`versions[].speakers` in `meeting.json`), never to the meeting, since a new transcription numbers speakers
  anew. `PUT /api/meetings/:id/versions/:version/speakers` names them under the meeting's lock; the reviewed
  record keeps its own names. A click is refused when the version's transcript, the suggestion or the speaker
  model changed since the page showed it.

## The lifecycle, and what is checked when

Remembering a voice is bound to what the user confirmed: the person comes from the name on the label, never from
the request. Before anything is read, the source, the transcript hash, the name and the setting are checked; the
recording's bytes are checked against its hash. Then, **under the store's lock, right before saving**:

- the label must still be named that person, on the same transcript and recording;
- nothing may have been forgotten in that workspace since the extraction started (a counter in `binding.json`);
- the person's voice must be the revision the extraction started from.

So an extraction that started before a Forget, a correction or another sample can never bring a voice back.

## Remaining risks

- The open set: someone never remembered who sounds like someone who was. The margin and the expected-people rule
  lower it; the user's click is the guard.
- The values come from synthetic voices; real meetings (laptop mics, compressed calls, overlap) will score lower.
- A voice remembered from a speaker diarization merged with another person carries both.
- Local processes and other users with access to this account can read `~/.gtd`, like the rest of the app's data.
- Recognising voices in the live transcript, people who are not stakeholders, and sharing voices between
  computers are out of scope.

## Privacy and the law

A voiceprint used to recognise someone is biometric data: special-category data under the GDPR (Art. 9), named
explicitly by Illinois' BIPA, and sensitive data under Brazil's LGPD. That is why the feature is off by default,
asks for consent per person and keeps the wording version, stays on this computer outside the workspace, is never
shared, and is easy to forget. Offline and local lowers the risk; it does not remove the duty to ask.
