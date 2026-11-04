# Links: telling the office that two agents talked

The office shows every running Claude Code, Codex, Cursor and Gemini agent on this Mac, and the teams it can read from
their own files. Anything else that makes agents talk to each other (a coordination tool, a task queue, a shared mailbox,
your own script) is invisible to it unless that tool says so. **Links** are how it says so: one JSON line per message,
appended to a file the office watches. No SDK, no socket, no registration; a shell `printf` is enough.

This is the contract (v1). The design behind it is in `AGENT_COMMUNICATION.md`. The office ships no adapter for any
particular tool: the tool that knows who talked to whom writes the lines.

## One line per link

```json
{"v":1,"id":"mytool:run-42:brief","at":"2026-10-26T06:12:16Z","kind":"brief",
 "from":"codex:01a1699f-a052-7ff3-a8d5-ed67be68fe12","to":"claude:1b3900e6-6067-4fba-b690-1d17d96aa569",
 "text":"Audit the native auth route","channel":"mytool"}
```

(one line in the file; it is wrapped here). Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | contract version, `1` |
| `kind` | yes | what the message does in the collaboration, one of the kinds below |
| `from`, `to` | yes | party refs (below): who sent it, who received it |
| `at` | yes | when: ISO 8601 (`2026-10-26T06:12:16Z`, offsets and fractions fine) or epoch milliseconds as a number |
| `id` | no | a stable id for dedupe, e.g. `mytool:<record id>:<kind>`; without one the office derives it from the line itself, so writing the same line twice is still one link |
| `text` | no | what was said, at most 200 characters, one line (the office truncates longer text); shown in bubbles, the Log and the timeline |
| `channel` | no | your tool's name, free text; shown in the Log and the Key, and used to name the file's links |

Unknown fields are ignored (keep your own, e.g. a record id, if that helps you debug). A line that is not valid JSON,
or lacks a required field, is skipped and counted in the server log; it never stops the file being read.

### Kinds

| `kind` | Means | What the office does |
| --- | --- | --- |
| `brief` | A gave B a task | B becomes a helper in A's team while both are present (unless B's own vendor already names a parent); B walks over to A's desk to be briefed, then takes a side desk in A's pod. A becomes a lead. |
| `reply` | B handed work back to A | the report walk: B prints the report, carries it to A, A's in-tray gains a sheet; `text` is the report snippet |
| `message` | anything in between | a "To B" / "From A" bubble on both, a Log entry |
| `review` | B is reviewing A's work | B collects the work at A's desk and reviews it at the QA desk |
| `verdict` | B's judgement on A's work | the stamp (✅ / ⚠️) and the walk back; `text` says the outcome ("accepted", "changes requested") |
| `handoff` | A's result became B's input | a sheet carried from A to B; B's work continues from it |
| `approval` | a human decision relayed by A to B | a short bubble on B ("Write approved"); it ends B's "waiting on you" if B was waiting |

Behaviour follows the first link of a kind between a pair; repeated lines with the same `id` are one link. Only
links whose `at` is recent (within the office's event window, about three minutes) move people and reach the journal:
a backlog written in one go is noted in the server log but not replayed, so run your adapter continuously or on a
timer rather than once a day. All links from a file have confidence **declared** (see below).

`start`: `from` started `to` as a chat of its own, which still belongs to the person: a nearby desk, a `↗` chip and a line on the worker card, but it joins no team, and its questions and its break are unchanged. Compare `brief` and `launch`, which adopt the worker into a team.

### Party refs

| Ref | Who | Where the id comes from |
| --- | --- | --- |
| `claude:<session-id>` | a Claude Code session | the uuid in `~/.claude/projects/<project>/<session-id>.jsonl`, `claude --resume <id>`, the `session_id` of a `system/init` event in `claude -p --output-format stream-json` |
| `codex:<thread-id>` | a Codex thread | the id in the Codex threads table and at the end of `~/.codex/sessions/.../rollout-…-<thread-id>.jsonl`; what `thread/start` returns from the app-server |
| `cursor:<id>` | a Cursor agent chat | the chat id in Cursor's state database |
| `gemini:<id>` | a Gemini CLI session | the session id in its logs / chat recordings |
| `pid:<n>` | the process running an agent | when your tool only knows what it launched; the office maps the pid to the session it belongs to (the Claude registry records pids; process ancestry does the rest) |
| `name:<label>` | a party the office cannot know | a coordinator chat on another machine, a human, your tool itself; drawn as a **stub** |

Both ends must resolve to agents in the office for anyone to act. A link with a `name:` end (or an id nobody present
owns) is still shown, as a stub bubble on the end that is here: "briefed by *relay · lab*", "sent to someone
outside the office", so a missing collector or a wrong id is noticed rather than hidden.

## Where the file goes

```
~/.ai-office/links/<tool>.jsonl        one file per tool (any *.jsonl in the folder is read)
$AI_OFFICE_LINKS_DIR/<tool>.jsonl      if the environment variable is set, for the office and for your tool
```

Create the folder if it is missing. UTF-8, one JSON object per line, `\n`-terminated. Write a whole line in one
`append` call (keep lines well under 4 KB) so a reader never sees half a line; if it does, that line is skipped and
the next one read.

**Append only.** The office reads each file incrementally, by byte offset, every poll; it never reads a file twice
from the start while the file keeps growing. Rewriting a file in place would make it miss or repeat lines.

**Rotation.** When a file shrinks (you truncated or replaced it), the office restarts it from byte 0. Links already
seen are dropped by `id`, so give links stable ids if you rotate; links older than the event window are ignored
anyway. Rotating by renaming (`mytool.jsonl` → `mytool.2026-10.jsonl`) is fine too: the old file is then read as a
file of its own until you move it out of the folder. Deleting a file just stops its links.

## Confidence: how surely the office knows

| Level | Where it comes from | Drawn as | Moves people? |
| --- | --- | --- | --- |
| **declared** | a link line from a tool (this format), or a vendor record naming both parties | solid thread, solid bubble | yes |
| **structural** | evidence the office gathers itself: spawn / parent records, process ancestry | solid thread | yes |
| **artifact** | (later) A wrote a file, B read it within a window | dashed thread | no |
| **inferred** | (later) content echo, timing | dotted thread, a hint only | no |

Only declared and structural links drive behaviour (walks, briefings, the report, waiting). Weaker evidence changes
what is drawn, never what people do, so a wrong guess can never make a character act out a conversation that did not
happen. The Key popover shows the three line styles.

### What the office gathers itself

You do not have to declare what the system already shows. If your tool's process launches an agent (`claude -p …`,
`codex app-server`, a Cursor or Gemini CLI) the office sees the process ancestry and records a `launch` link
(structural) from the agent that owns the launching process to the launched one: the launched agent's desk sits in the
launcher's pod. Declare the `brief` and the `reply` anyway: the launch says *who started whom*, your link says *what
was asked and what came back*, and the launch is missed when the launcher is not itself an agent the office knows.

## Privacy

- `text` is optional. The office never needs bodies; `kind`, `from`, `to`, `at` are enough for every behaviour.
- Keep secrets out: no tokens, credentials, file contents or private paths in `text`. Treat the links folder as the
  office's: it is read by a local server and ends up in `data/journal/` (local, gitignored) and on screen.
- Clip at 200 characters and collapse whitespace before writing; say what the message *is* ("Write approved",
  "review: accepted") rather than quoting it when quoting would leak.
- Your tool reads its own records; the office reads only the links folder. Nothing here asks the office to read
  your tool's state, and nothing asks your tool to read the office's.

## A ten-line adapter

Shell (`mytool-link brief codex:<id> claude:<id> "Audit the auth route"`):

```sh
#!/bin/sh
# usage: mytool-link <kind> <from> <to> [text]   appends one link line for the AI Office
dir="${AI_OFFICE_LINKS_DIR:-$HOME/.ai-office/links}"; mkdir -p "$dir"
at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
text=$(printf '%s' "${4:-}" | tr '\n\t' '  ' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"v":1,"at":"%s","kind":"%s","from":"%s","to":"%s","text":"%s","channel":"mytool"}\n' \
  "$at" "$1" "$2" "$3" "$text" >> "$dir/mytool.jsonl"
```

Node (no dependencies):

```js
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const dir = process.env.AI_OFFICE_LINKS_DIR || path.join(os.homedir(), '.ai-office', 'links');
fs.mkdirSync(dir, { recursive: true });
export function link(kind, from, to, text, id) {
  const l = { v: 1, id: id || `mytool:${Date.now()}:${kind}`, at: new Date().toISOString(), kind, from, to, channel: 'mytool' };
  if (text) l.text = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  fs.appendFileSync(path.join(dir, 'mytool.jsonl'), JSON.stringify(l) + '\n');
}
```

Call `link('brief', coordinator, worker, task, 'mytool:run-42:brief')` when you dispatch and
`link('reply', worker, coordinator, result, 'mytool:run-42:reply')` when the worker finishes. For a tool that keeps
its own records (a state file, a database) write a small reader on the tool's side: it turns records into links with
ids derived from the record ids, remembers what it has written (a sidecar file), and so can run again, or follow the
records, without repeating anything.

## Checking that it worked

1. `ls -l ~/.ai-office/links/` shows your file growing; `tail -1` shows a well-formed line.
2. With the office running (`npm start`) and both agents present, the **Log** pill lists the link within a poll or
   two ("codex briefed claude · mytool"); the helper walks to the lead's pod and gets briefed.
3. `node --no-warnings server/probe.js` prints who is in and the recent events, with the channel of each link;
   a stub end shows as `name:…`. Skipped lines (bad JSON, missing fields) are counted per file in the server log.
4. `data/journal/YYYY-MM-DD.jsonl` keeps the link as an event with `channel` and `confidence`; the **Today** drawer
   shows it as a marker on the sender's row with an arc to the receiver's; `npm run validate` flags links whose ends
   never appeared.
