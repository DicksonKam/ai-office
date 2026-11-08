# Communication between agents: how the office sees it

**Status: the general design, now built** (see "Where we are"). First recorded 2026-10-26 as an open
problem; rewritten the same day when the open format (`LINKS.md`) settled the direction. The office stops reading
*products* and starts reading **evidence that two agents talked**.

## The problem

The office shows each agent as a worker and, within one vendor, shows teams: a Claude lead with its Claude helpers, a
Codex lead with its Codex sub-agents, and the briefs, reports and verdicts that pass between them. It learns all of
that from the vendor's own files, because those files name both parties.

Agents increasingly talk *across* those boundaries, through layers the vendors know nothing about: a coordination tool
that lets one assistant dispatch bounded work to another, a shared mailbox folder, an issue thread, a channel, a script of your
own. Each one knows who talked to whom and has no way to tell the office. The office shows the two as strangers at
separate desks, and every new layer would need its own special case unless detection rests on something more basic
than "read vendor X's team field".

What is needed is a **general mechanism for detecting that agent A communicated with agent B**, independent of which
vendor either runs on and of which layer carried the message, plus a clear rule for **how the office shows it**, so a
glance at the building tells you who is working with whom, and how surely we know.

## First principles

### Communication is a link

Communication is information moving from one agent's context into another's, on purpose. For the office that
reduces to one thing, the **link**:

```
Link {
  id          stable, for dedupe (a tool's record id, or derived from the evidence)
  from, to    office identities (below), never raw vendor ids
  kind        brief | reply | message | review | verdict | handoff | approval | launch
  channel     how it travelled: a vendor's own records, a tool's name, a process, a file
  at          one instant, ms
  text?       ≤ 200 chars, optional, never required
  confidence  declared | structural | artifact | inferred
  evidence[]  the traces that made us believe it (file + offset, pid pair, …)
}
```

Everything the office already draws (briefings, the report walk, To/From bubbles, reviewer stamps, thread lines) is a
rendering of links. The first step of the build is to make `Link` the one thing every reader produces and the office
consumes; the vendor collectors then become two more readers rather than the definition of what a team is.

### Communication is only ever observed through traces

We never see the message in flight; we see what it left behind. Every reader is a reader of one trace type:

| Trace | Example | Tells us |
| --- | --- | --- |
| **Declared record** | a link line written by any tool (`LINKS.md`); Codex `agent_message` (author, recipient); a Claude `SubagentHandback` | both parties, the kind, often the text: the strongest evidence |
| **Structural** | Claude `subagents/agent-*.jsonl` with its parent; Codex `parent_thread_id`; a process that launched another agent's process | a lasting relationship (lead / helper, launcher / launched) |
| **Shared artifact** | A writes `tasks/T12/assignment.md`, B reads it; a `STATUS.md` edited by both | a link with the artifact as channel; direction from write-then-read order |
| **Shared medium with addressing** | an issue / PR thread, a channel, a database row with `to` | a link per post naming the addressee |
| **Content echo** | B's first prompt contains a paragraph A just produced | an inferred link: the weakest evidence, needs a long exact match |

A general detector is a set of trace readers producing candidate links, plus one resolver that merges them, scores
them and decides which to show. The open format exists so that the first row needs no reader per tool: the tool that
carried the message is the one that knows, and it writes the line.

### Identity: one agent, many names

Cross-layer links fail first on identity. The same Claude session is `claude:<session-id>` to the office, a
`session_id` in some tool's state file, a pid to the OS, and "the specialist" in a Codex prompt. The resolver keeps an
**identity table** mapping every observed name to one office identity:

| Observed name | Source | Joins to |
| --- | --- | --- |
| `claude:<session-id>` | Claude registry, transcript file name, `--resume`, `system/init` of `claude -p` | the Claude collector's id (the same uuid; verified against one coordination tool's records: 17 of 17 matched a transcript) |
| `codex:<thread-id>` | the Codex threads table, the rollout file name, `thread/start` | the Codex collector's id (4 of 4 threads that tool had recorded were in the table) |
| `cursor:<id>`, `gemini:<id>` | the collectors' own ids | themselves |
| `pid:<n>` | a `pid:` ref in a link; `ps` ancestry | the session whose registry entry or launch chain owns that pid |
| working directory + start time | any trace | a weak join, used only to confirm |
| `name:<label>` | a party nobody can resolve: a chat elsewhere, a human, the tool itself | nothing: a **stub** |

Rule: a link **drives behaviour only when both ends resolve** to agents the office knows. An unresolved end is drawn
as a visible stub ("briefed by *relay · lab*", "sent to someone outside the office") rather than guessed, so a
missing collector or a wrong id is noticed.

### Confidence is part of the data

| Level | Source | Drawn as | Moves people? |
| --- | --- | --- | --- |
| **declared** | a record or link line naming both parties | solid | yes |
| **structural** | spawn / parent / launch | solid | yes |
| **artifact** | write-then-read of the same file within a window | dashed | no |
| **inferred** | content echo, timing only | dotted, a hint | no |

Behaviour (a helper walking over to be briefed, a report carried by hand, the lead crossing arms while waiting) is
driven only by declared and structural links. Weaker links change what is *drawn* (a thread, a bubble), not what
people *do*, so a wrong inference can never make a character act out a conversation that never happened.

### Time and direction

Each link has one `at` and a direction. A conversation is a sequence of links between the same pair; the office needs
the sequence to show waiting ("sent a brief, no reply for 4 min") and turnaround (reply latency on the timeline).
Where a trace gives no clear direction (two agents editing one file), record two half-links and let the
write-then-read order decide, or leave the direction unknown and draw it without an arrow. Only recent links move
people: a backlog of history is not replayed as behaviour.

### Privacy by default

Read what names the parties and what classifies the message; show snippets only where the office already shows them
(briefs and reports, which the user wrote or asked for). Vendor message bodies that are encrypted stay that way.
`text` in a link is optional and capped; the format asks tools to keep secrets out and never asks for bodies. The
office reads only its own links folder and the vendors' local files; it never reads a tool's state, an inbox or a
chat the user has not pointed it at. Each future reader of a new trace type is opt-in in `server/config.js` with its
path.

## What the office does with links

### Teams across vendors

Teams are resolved by parent links, not by vendor. A `brief` from A to B makes B a helper in A's team while both are
present, unless B's own vendor already names a parent (the vendor's structure wins; a declared brief never re-parents
a Claude subagent away from its lead). A Codex lead with a Claude helper is then already representable: the helper
walks to the lead's pod, is briefed, works at a side desk, prints and hands in the report. The vendor difference inside
one pod is carried by the people themselves (shirt colour, screen glow). A **coordinator** whose helpers come and go
across sessions is a lead like any other, with an in-tray count of what came back.

### Kinds, and the behaviour each reuses

| Kind | Behaviour | Reused from |
| --- | --- | --- |
| `brief` | adoption into the team, the walk to the lead's desk, the briefing bubble, a kickoff if several arrive together | Claude `Agent` spawn, Codex `spawn_agent` |
| `reply` | the report walk, the in-tray sheet, the thread pulse | `SubagentHandback`, `task_complete` |
| `message` | To / From bubbles, a Log entry | Codex inter-agent messages |
| `review`, `verdict` | collect at the lead's desk, review at the QA desk, stamp, walk back | Guardian review threads |
| `handoff` | a sheet carried from A to B | the report walk |
| `approval` | a short bubble on the receiver; ends its "waiting on you" | the permission flow |
| `launch` | structure only: the launched agent's desk sits in the launcher's pod | the parent link |

### Channels have a place in the building

The channel is the honest metaphor for "how did the message get there":

| Channel | In the office |
| --- | --- |
| direct (vendor-native, a tool's declared link) | what exists now: walk over, brief at the desk, hand over the printed report |
| launch (process) | drawn as structure, not as a message |
| shared artifact (files, STATUS.md) | later: the **pigeonholes** by the print island: A drops a sheet, B collects it; the sheet waits visibly in between |
| shared medium (issue, channel) | later: the **notice board** in the social zone: a pinned note with both names; replies pin beneath |
| inferred | a dotted thread on the floor only; no walk, no bubble |

Distinct places mean a glance tells you *which layer* is carrying the collaboration, which is what you need when
debugging why a reply never arrived.

### Certainty is visible

Solid threads and bubbles for declared and structural links; dashed for artifact; dotted for inferred. The Key gains
the three line styles and the channel names. A stub end shows as a stub bubble, never as a guess.

### Waiting and latency

A brief with no reply is the most useful thing to show: the lead crosses arms (exists), the thread pulses slower the
longer it waits, and past a threshold the tag says "waiting 6 min". On the Today timeline each link is a marker on the
sender's row with a thin arc to the receiver's row; hovering shows the text and the turnaround.

### Journal and card

Every acted-on link is journaled as an event with `kind`, `from`, `to`, `channel`, `confidence`, `at`, so the Week
view can count collaborations and the worker card lists "Messages" alongside "Recent". The validator flags links
whose ends never appeared.

## Who is the question for? (recorded 2026-10-30, built 2026-10-31)

Observed live during a Codex → Claude handoff: a Codex chat (Sora) had a coordination tool start a Claude worker
(Suzu). Suzu raised its hand ("Needs your OK: …") and later showed "✓ your turn", and the office presented both as
**addressed to the person at the keyboard**. They were not: Suzu's work came from Sora, so its request for permission went to Sora's
side, and its finished work was **Sora's turn**, not the human's.

The principle, general and not tied to any tool: **an agent's ask and its hand-back are addressed to whoever gave it
the work.** Who gave it the work is exactly what links establish: a vendor parent (a Claude subagent's lead, a Codex
helper's lead), a declared `brief`, or an inferred `launch`. Only an agent that nobody else started, a person's own
chat, addresses the person.

What that means in the office:
- **Asking.** A worker with a delegator raises its hand *toward that delegator*: the delegator turns to look, the ask
  bubble names them ("Needs Sora's OK: …"), and it does not count in the header's "🙋 N waiting on you", trigger
  alerts or sounds, unless the delegator is itself waiting on the person (then the chain ends at the person) or no
  delegator is present.
- **Finished.** A worker with a delegator hands back to the delegator: the existing report walk for certain links
  (vendor or declared), or a "✓ Sora's turn" chip in the delegator's colour for inferred ones. It does not count in
  "✓ N ready for you". The delegator's own finish is the one that becomes the person's turn.
- **Certainty.** The addressee follows the strongest link. With only an inferred link the office should say so
  ("probably Sora's turn") rather than assert it, and keep the person informed if the request sits unanswered for
  long, since an inference can be wrong.
- **Already right today:** Claude subagents and Codex helpers (vendor links) hand back to their lead and never show
  "your turn". The gap is agents linked by weaker or tool-level evidence, and asks, which today always go to the person.

**How it is built (2026-10-31).**
- *Who gave the work* (`server/links/process.js`, `inferDelegations`): walk up from an agent's process to the first
  vendor host (a vendor CLI, the Desktop app's `codex app-server`, Cursor's app), stopping at another agent's process
  (its own launch link covers that) or at an interactive shell (a person typed the command, even in an editor's
  terminal). Exactly one top-level agent of that vendor, present in the same project and at work when the process
  started → an `inferred` `launch` link, one per job (process), and a remembered relation that outlives the process
  and survives resumes. Ambiguous moments keep the last answer; two candidates never produce a guess.
- *The snapshot* (`server/model.js`, `addressAsks`): `delegator { id, certain }` from a link adoption (certain) or the
  inferred relation; `askTo` = the delegator while it is in, not itself asking, and still working or stopped less
  than `askEscalateMs` (3 min) ago (seen live: asks stayed open 6 min while the delegator worked, and it answered them). A vendor's own helpers get no delegator: their prompts show in the person's own chat.
- *Journal*: `asking-start` carries `askTo`; entries carry `delegatedBy`. Neither an ask to an agent nor a delegated
  finish counts in "asked you", "finished" or waiting-on-you time.
- *Office*: the free desk nearest the giver; a work order on the desk front in the giver's colour (dog-eared when
  inferred); the job arrives as a phone call; the hand goes up seated, head turned to the giver, who glances over; the
  bubble names the giver ("Probably needs Sora's OK: …") in a paper style, never amber, never an edge chip, sound or
  alert; the hand-back is "Done · probably Sora's turn" and a dashed "✓ probably Sora's turn" chip; the worker then
  leaves on the helper timer. The line between them is drawn only while either name tag is hovered or focused.
- *Also fixed from the recording:* a headless worker that `cd`s into a subfolder is filed under the project it started
  in (the transcript folder names it), so it no longer "moves" to a project called after the subfolder.

## Plugin readers

`server/links/` holds one reader per trace type; each turns its trace into candidate links and nothing else. The
resolver (identity table, team adoption from briefs, dedupe by id, confidence, stubs) is shared.

| Reader | Trace | Confidence | Status |
| --- | --- | --- | --- |
| `declared` | `*.jsonl` under `~/.ai-office/links/` (env `AI_OFFICE_LINKS_DIR`), the open format in `LINKS.md`; incremental by file offset, a shrunken file restarts, malformed lines skipped and counted | declared | Milestone 11 |
| `process` | pid ancestry from `ps`; pids from the Claude registry and any `pid:` refs; emits `launch` | structural | Milestone 11 |
| `process` (host) | an agent process under another vendor's host, one candidate of that vendor at work in the project; emits `launch` | inferred | 2026-10-31 |
| vendor collectors | Claude subagents and handbacks, Codex spawns / messages / reports / verdicts, Cursor subagents, Gemini | declared / structural | exist; to be expressed as links |
| `artifact` | write-then-read of a file both agents touched; needs the reader's transcript to mention the path | artifact | later |
| `echo` | long exact match of A's output in B's input | inferred | later |

Tools write links; they do not need a reader in the office. The office deliberately ships no adapter for any
particular tool: the tool that knows who talked to whom is the one that writes the lines, and the office stays
general. A tool with a state file follows a simple shape: stable ids from record ids, a sidecar of what was written,
and a watch loop. (One such adapter was written and run against a real coordination tool's records during this
milestone to prove the contract and the identity join, then kept out of the office.)

## Where we are (Milestone 11)

- **Exists:** within one vendor, Claude `Agent` subagents (structural) and their `SubagentHandback` reports (declared);
  Codex `spawn_agent`, `agent_message`, `send_message`, `followup_task`, `task_complete` reports and Guardian verdicts
  (declared); Cursor subagents. See `server/model.js` (events) and `web/agents.js` (behaviour).
- **L1 · Server:** the `Link` type; the `declared` and `process` readers; the resolver; events carry `channel` and
  `confidence`; the journal keeps them.
- **L2 · Client:** brief / reply / handoff / launch behaviours by reuse, cross-vendor pods, thread styles by
  confidence, stub bubbles, Key entries, "Messages" on the card, timeline markers.
- **L3 · Docs:** `LINKS.md`, this note, the README section. Done. The contract was proven with a throwaway adapter on
  a real coordination tool's records (links of all six kinds; the identity join held for every Claude session id and
  every Codex thread id), and that adapter was then removed so the office carries nothing tool-specific.
- **L4 · Verify:** unit tests; a synthetic link between two live agents, drawn live.

**Milestone 12 added two more sources of evidence the office gathers on its own:**
- *Pids for every vendor:* Claude sessions carry an explicit pid (structural). Codex and Gemini have none on disk; the
  office joins a vendor CLI process to a thread by working directory and start time only when exactly one candidate
  and one claimant match, and marks that join weak: a launch link through a weak pid is drawn dashed (`artifact`) and
  never adopts anyone. Cursor has no usable process evidence. What was checked per vendor is written at the top of
  `server/links/process.js` and in each collector.
- *Shared files:* collectors expose the paths each agent wrote and read (from their transcripts, paths only); when
  agent A writes a path and agent B reads the same path within 30 minutes, that is an `artifact` link over the
  channel `file` (dashed, bubble only). Ordinary edits inside one shared repository are not links; a handoff folder
  (`collaboration/`, `handoff/`, `inbox/`, `mailbox/`, `STATUS.md`, `HANDOFF.md`) is. Five per pair per hour.

## Open questions

- **Coordinators across sessions:** a coordinator chat can hand its role to another; when does the "lead" desk change
  hands? A recorded `handoff` between coordinators is the signal; the rule for the desk is not decided.
- **Replaying history:** links older than the event window are ignored, which keeps behaviour honest but means a
  collaboration that happened while the office was down never reaches the Week view. A "journal only" path for old
  declared links may be worth it.
- **Artifact readers:** "who read a file" needs file-access traces macOS does not give cheaply; the practical signal is
  the reader's own transcript mentioning the path. Decide whether that counts as declared.
- **Scale:** many inferred links in a busy day would be noise; the resolver needs a budget per pair per hour.
- **Non-local agents:** cloud sessions leave no local files; they are outside the office until a declared link names
  them, and then only as stubs unless something local resolves them.
- **Trust:** the links folder is writable by anything on this Mac. The office treats links as data (they only ever
  draw and move characters), but a tool that lies about `from` can make a team look wrong. Per-file channel names in
  the Log keep the source visible.

## Jobs from any tool

Work that goes on outside an agent's turn is one record, whichever tool it comes from: `job { owner, kind: run | timer | schedule, label, state: running | waiting | done | failed | stopped | unknown, startedAt, nextAt, endedAt, evidence }` (`web/jobs.js`, `server/jobbook.js`). Past the readers, nothing knows a tool's name.

A tool, or a small wrapper around it, can report jobs with no change to the office: append one JSON line per update to any `*.jsonl` file in `~/.ai-office/jobs/` (`AI_OFFICE_JOBS_DIR` overrides the folder).

```
{"v":1,"id":"mytool:build-42","owner":"mytool:chat-7","kind":"run","state":"running","label":"Nightly build","at":"2026-11-03T06:12:16Z","pid":1234,"agent":{"name":"Fix the tests","project":"my-repo","status":"idle"}}
{"v":1,"id":"mytool:build-42","state":"done","at":"2026-11-03T06:40:02Z"}
```

- `id` and `owner` read `tool:something`. `owner` is an agent id the office knows, such as `claude:<session>`. If no reader reports that owner, `agent` gives it a worker while it has a job, in a neutral colour.
- `kind`: `run`, or `timer` with `nextAt`. `state`: `running`, `waiting`, `done`, `failed`, `stopped`. `at`: ISO 8601 or epoch ms.
- `pid` is optional; when it dies with no end line, the job ends as `unknown`. A job nobody reports ending never reads as finished.
- A run keeps its worker in the office until it ends. A timer does if due within 30 minutes. Schedules come from readers only for now (`DEFAULT_SCHEDULE_READERS` in `server/model.js`).

To read a tool directly instead, add a reader that returns the same observations to `DEFAULT_JOB_READERS` in `server/model.js`.

## Opening an agent's chat from the office

A reader may give an agent an `openUrl`. `server/open.js` keeps a list of link shapes that were checked by hand to show the chat and change nothing in it, and only those are ever used. The page sends `POST /api/open` with an agent id, never a link; the server looks the link up and runs `open` without a shell, and refuses anything without the office's own Origin. A helper opens the chat of the agent it works for. To add a tool: give its agents an `openUrl`, try the link on an idle chat, confirm its files do not change, then add its shape to the list.

