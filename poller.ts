#!/usr/bin/env bun
/**
 * Telegram poller for the mailbox plugin.
 *
 * This is the long-running half of the plugin. It owns Telegram's exclusive
 * getUpdates slot, runs inbound messages through the access gate, and appends
 * approved entries to mailbox.jsonl. Each appended entry is also announced on
 * stdout so the mailbox-check skill's Monitor wakes the /loop immediately.
 *
 * Cross-session exclusion is handled OUTSIDE this script: the Monitor wraps
 * `bun poller.ts` in `flock` against STATE_DIR/poll.lock. Whichever session
 * grabs the lock polls; the rest block in flock until it exits, then take
 * over. Lock release is automatic on process death (kernel-managed), so
 * crashes can't strand the slot.
 *
 * The MCP server (server.ts) does not poll — it only exposes tool handlers
 * over stdio. Multiple sessions can run their server.ts concurrently because
 * sendMessage / setMessageReaction / getFile / editMessageText have no
 * exclusivity at Telegram's API.
 */

import { Bot, GrammyError, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  renameSync,
  chmodSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname } from 'path'

const STATE_DIR = process.env.TELEGRAM_MAILBOX_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram-mailbox')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const MAILBOX_FILE = join(STATE_DIR, 'mailbox.jsonl')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20

// Load .env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=([^\r\n]*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

if (!TOKEN) {
  process.stderr.write(
    `telegram-mailbox poller: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram-mailbox poller: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram-mailbox poller: uncaught exception: ${err}\n`)
})

const bot = new Bot(TOKEN)
let botUsername = ''

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(`telegram-mailbox poller: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'telegram-mailbox poller: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) {
      return true
    }
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

// Approval polling: the access skill drops files at approved/<senderId>; we
// send the confirmation DM and clean up. Folded into the poller's setInterval
// so this runs only when a poller is alive, not from every MCP server.
function checkApprovals(): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`telegram-mailbox poller: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}

if (!STATIC) setInterval(checkApprovals, 5000).unref()

function inboxFilename(filePath: string, uniqueId: string | undefined, fallbackExt: string): string {
  const ext = extname(filePath).slice(1).replace(/[^a-zA-Z0-9]/g, '') || fallbackExt
  const uid = (uniqueId ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
  return `${Date.now()}-${uid}.${ext}`
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"\\]/g, '_')
}

const rateWindow = new Map<string, number[]>()
const rateNotifiedAt = new Map<string, number>()

function rateLimitAllow(senderId: string): boolean {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const times = (rateWindow.get(senderId) ?? []).filter(t => t > cutoff)
  if (times.length >= RATE_LIMIT_MAX) {
    rateWindow.set(senderId, times)
    return false
  }
  times.push(now)
  rateWindow.set(senderId, times)
  return true
}

function maybeReplyRateLimited(ctx: Context, senderId: string): void {
  const now = Date.now()
  const last = rateNotifiedAt.get(senderId) ?? 0
  if (now - last < RATE_LIMIT_WINDOW_MS) return
  rateNotifiedAt.set(senderId, now)
  void ctx.reply(`rate limited — max ${RATE_LIMIT_MAX}/min`).catch(() => {})
}

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS
  for (const [id, times] of rateWindow) {
    const kept = times.filter(t => t > cutoff)
    if (kept.length === 0) rateWindow.delete(id)
    else if (kept.length !== times.length) rateWindow.set(id, kept)
  }
  for (const [id, last] of rateNotifiedAt) {
    if (last <= cutoff) rateNotifiedAt.delete(id)
  }
}, RATE_LIMIT_WINDOW_MS).unref()

type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const result = gate(ctx)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(
      `${lead} — run in Claude Code:\n\n/telegram-mailbox:access pair ${result.code}`,
    )
    return
  }

  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  if (!rateLimitAllow(String(from.id))) {
    maybeReplyRateLimited(ctx, String(from.id))
    return
  }

  // 👀 reaction is the user-visible signal that a poller is alive and the
  // message passed the gate. No reaction means either no session is currently
  // polling (no /mailbox-check loop running) or the message was dropped.
  const ackEmoji = result.access.ackReaction ?? '👀'
  if (ackEmoji && msgId != null) {
    void bot.api.setMessageReaction(chat_id, msgId, [
      { type: 'emoji', emoji: ackEmoji as ReactionTypeEmoji['emoji'] },
    ]).catch(err => {
      process.stderr.write(`telegram-mailbox poller: ackReaction failed: ${err}\n`)
    })
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  const entry = {
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    update_id: ctx.update.update_id,
    from_id: String(from.id),
    chat_id,
    ...(msgId != null ? { message_id: msgId } : {}),
    user: from.username ?? String(from.id),
    text,
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(attachment ? {
      attachment_kind: attachment.kind,
      attachment_file_id: attachment.file_id,
      ...(attachment.size != null ? { attachment_size: attachment.size } : {}),
      ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
      ...(attachment.name ? { attachment_name: attachment.name } : {}),
    } : {}),
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(MAILBOX_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 })
    // Stdout line is the Monitor's wake event for /loop. Keep it short — every
    // line becomes a chat notification in the consuming session.
    process.stdout.write(`new mailbox entry: from=${from.username ?? from.id} update_id=${ctx.update.update_id}\n`)
  } catch (err) {
    process.stderr.write(`telegram-mailbox poller: failed to append mailbox entry: ${err}\n`)
  }
}

bot.command('start', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `This bot bridges Telegram to a Claude Code session.\n\n` +
    `To pair:\n` +
    `1. DM me anything — you'll get a 6-char code\n` +
    `2. In Claude Code: /telegram-mailbox:access pair <code>\n\n` +
    `After that, DMs here reach that session.`
  )
})

bot.command('help', async ctx => {
  if (!dmCommandGate(ctx)) return
  await ctx.reply(
    `Messages you send here route to a paired Claude Code session. ` +
    `Text and photos are forwarded; replies and reactions come back.\n\n` +
    `/start — pairing instructions\n` +
    `/status — check your pairing state`
  )
})

bot.command('status', async ctx => {
  const gated = dmCommandGate(ctx)
  if (!gated) return
  const { access, senderId } = gated

  if (access.allowFrom.includes(senderId)) {
    const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
    await ctx.reply(`Paired as ${name}.`)
    return
  }

  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(
        `Pending pairing — run in Claude Code:\n\n/telegram-mailbox:access pair ${code}`
      )
      return
    }
  }

  await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
})

bot.on('message:text', async ctx => {
  await handleInbound(ctx, ctx.message.text, undefined)
})

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      const buf = Buffer.from(await res.arrayBuffer())
      const path = join(INBOX_DIR, inboxFilename(file.file_path, best.file_unique_id, 'jpg'))
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch (err) {
      process.stderr.write(`telegram-mailbox poller: photo download failed: ${err}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'document',
    file_id: doc.file_id,
    size: doc.file_size,
    mime: doc.mime_type,
    name,
  })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  const text = ctx.message.caption ?? '(voice message)'
  await handleInbound(ctx, text, undefined, {
    kind: 'voice',
    file_id: voice.file_id,
    size: voice.file_size,
    mime: voice.mime_type,
  })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
  await handleInbound(ctx, text, undefined, {
    kind: 'audio',
    file_id: audio.file_id,
    size: audio.file_size,
    mime: audio.mime_type,
    name,
  })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  const text = ctx.message.caption ?? '(video)'
  await handleInbound(ctx, text, undefined, {
    kind: 'video',
    file_id: video.file_id,
    size: video.file_size,
    mime: video.mime_type,
    name: safeName(video.file_name),
  })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, {
    kind: 'video_note',
    file_id: vn.file_id,
    size: vn.file_size,
  })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, {
    kind: 'sticker',
    file_id: sticker.file_id,
    size: sticker.file_size,
  })
})

bot.catch(err => {
  process.stderr.write(`telegram-mailbox poller: handler error (polling continues): ${err.error}\n`)
})

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram-mailbox poller: shutting down\n')
  // bot.stop() signals the poll loop to end; the current getUpdates request
  // may take up to its long-poll timeout to return. Force-exit after 2s so
  // flock(1) releases the lock for the next session.
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

const bootPpid = process.ppid
setInterval(() => {
  const orphaned =
    (process.platform !== 'win32' && process.ppid !== bootPpid) ||
    process.stdin.destroyed ||
    process.stdin.readableEnded
  if (orphaned) shutdown()
}, 5000).unref()

// 409 means another poller has the slot — with flock in place across our
// sessions, that should only happen if a non-claude-code process is using the
// same token. Retry with backoff but give up after 8 to avoid a tight loop
// against an unfixable conflict.
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          botUsername = info.username
          process.stderr.write(`telegram-mailbox poller: polling as @${info.username}\n`)
          void bot.api.setMyCommands(
            [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
            ],
            { scope: { type: 'all_private_chats' } },
          ).catch(() => {})
        },
      })
      return
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        process.stderr.write(
          `telegram-mailbox poller: 409 Conflict persists after ${attempt} attempts — ` +
          `another process holds the bot token outside our flock. Exiting.\n`,
        )
        process.exit(1)
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409
        ? `409 Conflict${attempt === 1 ? ' — another instance is polling outside our lock' : ''}`
        : `polling error: ${err}`
      process.stderr.write(`telegram-mailbox poller: ${detail}, retrying in ${delay / 1000}s\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
