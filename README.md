# AgentView

One view of every AI coding agent on your machine, and a way to answer them from your phone.

AgentView watches the transcript files that Claude Code and Codex write as they
work. It shows each session as an agent with a name and a face, tells you which
one needs you, and lets you reply to sessions you launched through its wrapper.

## Why

Run several agents at once and the hard question stops being "what is this one
doing" and becomes "which one is waiting on me". Terminal tabs do not answer
that. AgentView is a radar: one glance tells you who needs you, where it is
working, and what it is doing right now.

## What it does

- **Finds sessions on its own.** It reads `~/.claude/projects` and
  `~/.codex/sessions`, so terminal sessions and Claude Desktop sessions both
  appear with no setup.
- **Tells a real question from small talk.** An agent that asks something raises
  an amber alarm. An agent that merely finished speaking gets a calm "waiting"
  chip. A pending tool with a dead spinner is flagged as a likely permission
  prompt.
- **Mirrors the live terminal.** Wrapped sessions stream every byte, so you see
  the real screen, including the status line and the spinner.
- **Takes your reply.** Type into the terminal from the browser, on a laptop or
  a phone. A key bar sends Escape, Tab, Ctrl+C, the arrows, and Enter.
- **Works on a phone.** The list is the home screen, a session opens full
  screen, and the browser back button returns to the list.

## Install

Node 20 or later.

```bash
git clone git@github.com:vbudhram/AgentView.git
cd AgentView
npm install
npm run build
npm start
```

Open http://127.0.0.1:4400.

Use `npm run dev` while you change the code. Server code lives in a long-lived
singleton, so restart the server after you change anything under `src/lib`,
`server.mjs`, or the API routes.

## Steering: the `av` wrapper

AgentView reads transcripts for every session. To also **type into** a session,
start it through the wrapper. The wrapper runs the agent inside a pseudo
terminal and streams it to the app.

```bash
npm link          # puts `av` on your PATH
av claude         # instead of `claude`
av codex          # instead of `codex`
```

Make it the default:

```bash
echo "alias claude='av claude'" >> ~/.bash_profile
echo "alias codex='av codex'"  >> ~/.bash_profile
```

Your terminal behaves exactly as before. The app gains a Terminal tab, a live
mirror, and a reply box for that session. A session started without the wrapper
stays read only, and the app says so.

To wrap a session that already runs, exit it and resume it wrapped:

```bash
av claude --continue
```

## Reaching it from your phone

The server also listens on your Tailscale address, so any device on your tailnet
can open it:

```
http://<your-tailscale-ip>:4400
```

Nothing is exposed to your LAN or the internet. The listener binds only to
loopback and the tailnet interface, and the server rejects requests whose `Host`
header is neither.

## How it works

```
transcript files ─▶ collectors ─▶ parsers ─▶ session store ─▶ SSE ─▶ browser
   av wrapper ◀────▶ unix socket ◀───▶ bridge ◀───▶ WebSocket ◀────▶ terminal
```

- **Collectors** (`src/lib/collectors.ts`) watch both transcript directories and
  tail new lines.
- **Parsers** (`src/lib/parsers/`) turn two different JSONL formats into one
  event model.
- **The store** (`src/lib/store.ts`) holds sessions in memory, derives status,
  and writes the one-line summary of what each agent does now.
- **The bridge** (`src/lib/bridge.ts`) accepts wrapper connections on a Unix
  socket, models the terminal screen, and relays bytes both ways.
- **The UI** (`src/components/`) streams updates over SSE and terminal bytes
  over a WebSocket.

Two details are load bearing. The mirror renders at the terminal's exact grid
size, because a redraw at the wrong width corrupts cursor-addressed output. A
viewer that attaches mid stream gets a clean redraw from the screen model, never
raw scrollback that can start inside an escape sequence.

## Security

The trust boundary is your machine and your tailnet.

- The web server binds to loopback and the tailnet address only.
- It validates the `Host` header, and the `Origin` header on WebSockets, so a
  web page cannot reach it through DNS rebinding.
- The bridge socket is `0600`, so only your user can connect.
- There is **no authentication**. Anyone who can reach the port can read your
  transcripts and type into wrapped sessions. That is fine for a single user
  machine and a private tailnet. Add a token before you share either.

## Configuration

| Variable | Purpose |
| --- | --- |
| `AGENTVIEW_IGNORE` | Colon separated path prefixes to hide. Defaults to tool directories such as `~/.claude-mem`, `~/.claude`, `~/.codex`, and temp directories, so a plugin's own agents do not drown the list. |

## Limits

- Claude Desktop sessions are read only. The desktop app talks to its agents
  over a private channel, so nothing outside it can send input.
- The spinner ticker reads Claude Code's status line. Codex uses a different
  format and shows no ticker, though its mirror works.
- The list covers the last 24 hours.
- A wrapper started before an upgrade keeps the old protocol until you restart
  that session. The app marks it.

## Development

```bash
npm test              # vitest
npx tsc --noEmit      # types
npm run build         # production build
```

Tests cover the parsers, the tailer, the store's status rules, the terminal
screen model, and the bridge, including two wrappers competing for one session.
