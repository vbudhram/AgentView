# AgentView

A dashboard for the AI coding agents running on your machine, and a way to
answer them from your phone.

It watches the transcript files Claude Code and Codex write while they work.
Each session shows up with a name and a face, the ones that need you say so, and
you can type back into any session you started through the wrapper.

## Why I built it

I kept running four or five agents at once, and the question was never "what is
this one doing". It was "which one is sitting there waiting on me". Terminal
tabs are useless for that. You end up cycling through them like a man checking
whether he left the stove on.

So: one screen that answers it. Who needs you, where it is, what it is doing.

## What it does

Finds sessions by itself. It reads `~/.claude/projects` and
`~/.codex/sessions`, so terminal and Claude Desktop sessions both show up with
no setup.

Knows a question from small talk. An agent that actually asks you something
raises an amber alarm. An agent that just finished talking gets a quiet
"waiting" chip. This distinction took a few rounds to get right, and it is the
difference between a dashboard you trust and one you learn to ignore.

Mirrors the real terminal. Wrapped sessions stream every byte, so you see the
actual screen, spinner and status line included.

Takes your reply, from a laptop or a phone. There is a key bar for Escape, Tab,
Ctrl+C, the arrows, and Enter, because a phone keyboard has none of them.

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

Use `npm run dev` while you work on it. The server keeps its state in a
long-lived singleton, so restart it after you touch anything in `src/lib`,
`server.mjs`, or the API routes. Only client components hot reload.

## Typing back: the `av` wrapper

Reading works for every session. To also type into one, start it through the
wrapper, which runs the agent inside a pseudo terminal and streams it to the app.

```bash
npm link          # puts `av` on your PATH
av claude         # instead of `claude`
av codex          # instead of `codex`
```

Set it and forget it:

```bash
echo "alias claude='av claude'" >> ~/.bash_profile
echo "alias codex='av codex'"  >> ~/.bash_profile
```

Your terminal behaves exactly as before. The app gains a Terminal tab, a live
mirror, and a reply box for that session. Sessions started without the wrapper
stay read only, and the app tells you so instead of just hiding the tab.

Already running something you want to steer? Exit it and pick it back up
wrapped:

```bash
av claude --continue
```

## From your phone

The server also listens on your Tailscale address, so anything on your tailnet
can open it:

```
http://<your-tailscale-ip>:4400
```

Nothing is exposed to your LAN or the internet. It binds to loopback and the
tailnet interface only, and rejects requests whose `Host` header is neither.

## How it works

```
transcript files ─▶ collectors ─▶ parsers ─▶ session store ─▶ SSE ─▶ browser
   av wrapper ◀────▶ unix socket ◀───▶ bridge ◀───▶ WebSocket ◀────▶ terminal
```

Collectors (`src/lib/collectors.ts`) watch both transcript directories and tail
new lines. Parsers (`src/lib/parsers/`) flatten two different JSONL formats into
one event model. The store (`src/lib/store.ts`) keeps sessions in memory, works
out each one's status, and writes the one-line summary of what it is doing. The
bridge (`src/lib/bridge.ts`) takes wrapper connections over a Unix socket,
models the terminal screen, and relays bytes both ways.

Two things in there are easy to "clean up" and break, so before you touch them:
the mirror renders at the terminal's exact grid size on purpose, because a
redraw at the wrong width lands cursor moves on the wrong cells and smears the
text. And a browser attaching mid-stream gets a fresh redraw built from the
screen model, not raw scrollback, which can start halfway inside an escape
sequence.

## Security

The trust boundary is your machine and your tailnet.

The web server binds to loopback and the tailnet address only. It checks the
`Host` header, and `Origin` on WebSocket upgrades, so a random web page cannot
reach it by DNS rebinding. The bridge socket is `0600`.

There is no authentication. Anyone who can reach the port can read your
transcripts and type into wrapped sessions. That is fine for one person on a
private tailnet. Put a token in front of it before that stops being true.

## Configuration

`AGENTVIEW_IGNORE` takes a colon-separated list of path prefixes to hide. It
defaults to tool directories (`~/.claude-mem`, `~/.claude`, `~/.codex`) and temp
directories. Without it, plugins that run their own agents bury your actual
work: claude-mem's observers alone put 47 sessions in my list.

## Known limits

Claude Desktop sessions are read only. The desktop app talks to its agents over
a private channel and nothing outside it can send input.

The spinner ticker reads Claude Code's status line. Codex formats its own
differently, so those sessions get a mirror but no ticker.

The list covers the last 24 hours.

A wrapper started before an upgrade keeps talking the old protocol until you
restart that session. The app flags it rather than quietly rendering it wrong.

## Development

```bash
npm test              # vitest
npx tsc --noEmit      # types
npm run build         # production build
```

Tests cover the parsers, the tailer, the store's status rules, the terminal
screen model, and the bridge, including the case where two wrappers fight over
the same session.
