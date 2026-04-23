# Telegram Mailbox

A fork of the [official telegram plugin](https://github.com/anthropics/claude-plugins-official) that persists inbound Telegram messages to an on-disk mailbox instead of wiring them in as live session input. Use a `/loop` to drain the mailbox from any ordinary Claude session — **no `claude --channels` flag required**.

## How it's different

| | Official `telegram` | `telegram-mailbox` (this fork) |
|---|---|---|
| Delivery | MCP notification → session input | Append to `mailbox.jsonl` |
| Requires `--channels` at launch | yes | no |
| Coupled to session lifecycle | yes | no |
| Draining | automatic, in-session | `/loop /telegram-mailbox:mailbox-check` |
| Bot token | same token, one `getUpdates` consumer only | **separate token from the official plugin** |

Both plugins can run side-by-side as long as they use different bot tokens (Telegram returns 409 Conflict if two pollers share a token).

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- A second Telegram bot from [@BotFather](https://t.me/BotFather) (do not reuse the official plugin's token)

## Install

```
/plugin install <path-to-this-repo>
```

Then restart Claude so the MCP server starts.

## Setup

```
/telegram-mailbox:configure 123456789:AAH...
/telegram-mailbox:access                    # pair yourself, then switch policy to allowlist
```

Recommended BotFather hardening: `/mybots → <bot> → Bot Settings → Allow Groups? → Disable`, `Privacy → Enable`.

## Use

In any session where you want to accept phone-steering:

```
/loop 60s /telegram-mailbox:mailbox-check
```

Message the bot from your phone — `✓ queued` ack, then within ~60s the loop drains the entry and Claude replies with the result. `/pause`, `/resume`, `/status` are recognized as special commands; everything else is treated as an instruction for the current session.

## Tools exposed to Claude

| Tool | Purpose |
|---|---|
| `mailbox_read_new` | Read unprocessed mailbox entries from `processed_offset` to EOF. Does not advance the cursor. |
| `mailbox_ack` | Advance `processed_offset` to mark entries handled. |
| `reply` | Send text / photos / documents to a Telegram chat. |
| `react` | Add an emoji reaction (Telegram's fixed whitelist). |
| `edit_message` | Edit a previously-sent bot message (silent — no push). |
| `download_attachment` | Fetch a file attachment by `file_id` into the inbox. |

## State

All state lives under `~/.claude/channels/telegram-mailbox/`:

- `.env` — `TELEGRAM_BOT_TOKEN` (chmod 600)
- `access.json` — pairing/allowlist policy
- `mailbox.jsonl` — append-only message queue
- `processed_offset` — byte offset of the last handled entry
- `inbox/` — downloaded photos and attachments
- `bot.pid` — singleton PID for stale-poller eviction

## Rate limiting

Per-sender sliding 60-second window, cap 20 messages. The 21st message and onward are dropped with one "rate limited" reply per minute per sender.

## Access control

Inherited unchanged from the official plugin: pairing flow, allowlists, group policies, mention detection. See [ACCESS.md](./ACCESS.md) for details.
