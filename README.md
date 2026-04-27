# Telegram Mailbox

A fork of the [official telegram plugin](https://github.com/anthropics/claude-plugins-official) that persists inbound Telegram messages to an on-disk mailbox instead of wiring them in as live session input. Use a `/loop` to drain the mailbox from any ordinary Claude session — **no `claude --channels` flag required** and no token utilization while in the loop.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`. Make sure `~/.bun/bin` is on your `$PATH` in whichever shell launches Claude Code.

## Setup

1. **Get a bot token from BotFather.** In Telegram, DM [@BotFather](https://t.me/BotFather), run `/newbot`, and follow the prompts to name the bot. BotFather replies with an HTTP API token — that's the `<bot-token>` referenced below.

2. **(Recommended) Harden the bot in BotFather.** `/mybots → <your bot> → Bot Settings`:
   - `Allow Groups? → Disable` (DM-only)
   - `Group Privacy → Enable` (only @mentions and replies reach the bot in any group)

3. **Install the plugin.** Clone this repo, then:

   ```
   /plugin install <path-to-this-repo>
   ```

   Restart Claude Code so the MCP server starts.

4. **Save the token.** In any Claude session:

   ```
   /telegram-mailbox:configure <bot-token>
   ```

   The token is written to `~/.claude/channels/telegram-mailbox/.env` (chmod 600) and never leaves your machine.

5. **Pair yourself and lock down to an allowlist.** The default `dmPolicy` is `pairing` — new senders get a 6-char code back instead of being forwarded.

   a. From the Telegram account you want to allow, DM your bot any message (e.g. `hi`). The bot replies with a 6-char pairing code.

   b. In Claude, approve the code (this adds your Telegram user ID to `allowFrom`):

      ```
      /telegram-mailbox:access pair <code>
      ```

   c. Switch policy to allowlist so unknown senders are ignored instead of getting a pairing code:

      ```
      /telegram-mailbox:access policy allowlist
      ```

   d. (Optional) Confirm state — `/telegram-mailbox:access` with no args prints the current `dmPolicy` and `allowFrom` list.

6. **Verify.** DM your bot from the allowlisted account. The message should land in `~/.claude/channels/telegram-mailbox/mailbox.jsonl`.

## Use

In any session where you want to accept phone-steering:

```
/loop /telegram-mailbox:mailbox-check
```

No interval — the loop runs in dynamic mode: it arms a filesystem `Monitor` on `mailbox.jsonl` and only wakes the session when new bytes arrive (plus a ~30 min fallback heartbeat). Idle cost is effectively zero; latency from phone to reply is a few seconds.

`/pause`, `/resume`, `/status` are recognized as special commands; everything else is treated as an instruction for the current session.

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
