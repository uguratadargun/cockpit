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
- **Runs are yours.** The app authenticates with your own `gatec_…` token,
  the one the Team page hands out, and gate's client API shows it the runs you
  started and nothing else — a snapshot of the unfinished ones, then every
  event as it happens, on one connection.

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
