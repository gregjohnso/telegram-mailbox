---
name: configure
description: Set up the Telegram mailbox — save the bot token and review access policy. Use when the user pastes a Telegram bot token for the mailbox bot, asks to configure telegram-mailbox, asks "how do I set this up" or "who can reach me," or wants to check mailbox status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /telegram-mailbox:configure — Telegram Mailbox Setup

Writes the bot token to `~/.claude/channels/telegram-mailbox/.env` and orients the
user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/telegram-mailbox/.env` for
   `TELEGRAM_BOT_TOKEN`. Show set/not-set; if set, show first 10 chars masked
   (`123456789:...`).

2. **Access** — read `~/.claude/channels/telegram-mailbox/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes and display names if any

3. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/telegram-mailbox:configure <token>` with the token from
     BotFather."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Telegram. It replies with a code; approve with `/telegram-mailbox:access pair
     <code>`."*
   - Token set, someone allowed, policy is `allowlist` → *"Ready. In any
     session where you want to accept phone-steering, run `/loop
     /telegram-mailbox:mailbox-check` — it arms a Monitor on the mailbox
     file so the session only wakes when a message actually arrives."*
   - Token set, someone allowed, policy still `pairing` → push lockdown
     first (see below), then suggest the same `/loop`.

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture Telegram user IDs you don't know. Once the IDs are in, pairing
has done its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/telegram-mailbox:access policy allowlist`. Do this proactively — don't wait to
   be asked. Once flipped, suggest `/loop /telegram-mailbox:mailbox-check`
   as the default way to enable phone-steering in any session.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/telegram-mailbox:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone: *"They'll need to give you their numeric ID
   (have them message @userinfobot), or you can briefly flip to pairing:
   `/telegram-mailbox:access policy pairing` → they DM → you pair → flip back."*

Never frame `pairing` as the correct long-term choice. Don't skip the lockdown
offer.

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). BotFather tokens look
   like `123456789:AAH...` — numeric prefix, colon, long string.
2. `mkdir -p ~/.claude/channels/telegram-mailbox`
3. Read existing `.env` if present; update/add the `TELEGRAM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/telegram-mailbox/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the token

Delete the `TELEGRAM_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/telegram-mailbox:access` take effect immediately, no restart.
