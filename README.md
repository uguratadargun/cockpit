# gate cockpit

One window for every gate run you are driving: the terminals, the questions
they ask, the approvals they wait for, and the workflow each one is walking.

A person running four or five `/gate:run`s has four or five terminals and no
way to tell which one is waiting on them. The cockpit puts the terminals in one
window and takes the questions out of them: a run's `clarify` node lands in
**Questions**, its `plan-review` and `acceptance` nodes and every permission
prompt in **Approvals**, and each run's graph in **Executions**, lit at the
node it is on. Answering in the window continues the run in its terminal.

## How it works

- **Terminals are real Claude Code.** Each session is a `claude` process in a
  pty (node-pty), drawn with xterm.js. Nothing is emulated and nothing is
  typed into a terminal on your behalf.
- **Terminals start in auto mode.** A run typed in here walks a pipeline of
  nodes that read the project, write to its worktree and run its own commands;
  in Claude Code's default mode each of those stops for an approval, which is
  the waiting this window exists to end. Every terminal the cockpit starts —
  on this machine or on the gate server — begins with `--permission-mode auto`,
  which decides the ordinary actions and still sends what it will not decide to
  **Approvals**. Shift+Tab in the terminal changes the mode for that session.
- **Questions come out through hooks.** Every terminal the cockpit starts is
  given a settings file whose hooks talk to the app over a unix socket. A
  `PreToolUse` hook on `AskUserQuestion` holds the question until you answer
  it here and hands the answer back as the tool's input; a `PermissionRequest`
  hook does the same for permission prompts, plan approval included. The
  terminal never shows the prompt. With the app closed, the hooks are inert
  and Claude Code behaves as it always does.
- **The run says which is which.** gate writes what every session was last
  told to do to `~/.gate/sessions/<session>.json`, including whether the node
  is a `question` or an `approval`; the cockpit reads it to sort the two
  panels and to name the run and node on each session.
- **Idle terminals go to sleep.** A `claude` at its prompt holds a few
  hundred megabytes, and six of them add up. A terminal idle for ten
  minutes — nothing typed or printed, no question out, no run in its hands —
  is ended; its transcript is the session, so clicking it resumes it where it
  was. `COCKPIT_HIBERNATE_MIN` changes the wait; `0` turns it off.
- **Runs are yours.** The app authenticates with your own `gatec_…` token,
  the one the Team page hands out, and gate's client API shows it the runs you
  started and nothing else — a snapshot of the unfinished ones, then every
  event as it happens, on one connection. A finished run says where its
  branch went: gate pushes it as the worktree is released and the row reads
  *pushed*, with the ref and commit in the run's header, or why the push
  failed. The usage bars follow gate's own reading of its windows: a model's
  weekly window (Fable, Opus, Sonnet) running out blocks that model alone, so
  it is drawn low, never as the pool being held back by the floor.
- **Remote sessions run on the gate server.** A new session or run can go to
  *This machine* (everything above) or to the *Gate server*: gate starts a
  real `claude` in a pty on its own host, in one of its connected
  repositories — picked for you when your project's `origin` matches one's
  source — and the cockpit shows it like any other session: its terminal in
  Sessions (marked with a cloud), its questions and approvals in their panels,
  its run in Executions, the run's changed files read from its worktree on
  the server. Bytes, questions and state come over one client-API stream;
  typing is coalesced and sent in order. The session is the server's: closing
  the window leaves it running, and reopening the cockpit brings back its
  screen and anything waiting on you. It needs a key with the `remote` scope
  (ticked on the gate's Team page) and a gate of 0.35.0 or later; without
  either the option is shown off with the reason.

## Development

```bash
npm install        # rebuilds node-pty for Electron
npm run dev
npm run typecheck
npm test
```

First launch: the setup screen checks for `claude` on your login shell's PATH,
installs the `gate` plugin from the marketplace if it is missing, and asks for
your token. Everything it writes goes to `~/.gate/client.json` (the same file
the `gate` CLI uses) and the app's own data directory.

Requires Claude Code 2.1.85 or later (hook-supplied answers to
`AskUserQuestion`); built and tested against 2.1.266.

## Lineage

The terminal plane (pty ownership, one xterm per terminal for the app's life,
redraw and WebGL recovery) and the hook socket follow
[Office](https://github.com/uguratadargun/office), MIT.
