import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { FirstText, FlowStamp, OpenerCaps, PromptStamp, ShipStamp, StepStamp, TestRunStamp, TurnClose } from '../types'
import { VERB_W, activityHead, changeParts, diffRows, diffTop, foldOf, foldRow, layoutStep, mcpName, relPath, stepOf, stepParts } from './activity'
import type { Step } from './activity'
import { browserBottom, browserTarget, browserTool, browserTop, browserUrl, browserVerb, openRunBefore, urlBar } from './browser'
import { drawLive, logAsk, logMode, logSaid, logStepEnd, logStepStart, logTurnEnd, logTurnStart, registerCockpit, startCockpit } from './cockpit'
import { C, G, Rule, clip, fmtClock, fmtDuration, fmtTokens, layout, pad, ruleWidth, vw } from './grid'
import type { Lay, Ui } from './grid'
import { splitBlocks } from './blocks'
import { figureLines } from './figure'
import type { Block } from './blocks'
import { NO_CAPS, NO_TALLY, capsLine, hasCaps, hookOutcome, skillName, spinnerWord, tallyText, withHook, withMcp, withSkill } from './live'
import { cardCalls, isShipCommand, mergeShips, parseShip, parseTests, previousRun, runnerOf, shellText, shippedFrame, testsFrame } from './outcome'
import { parseInline, spansOf, toWords, wrapPlain, wrapWords } from './prose'
import type { Run, Span } from './prose'
import { footnoteLines, parseCited, sourcesFrame, sup } from './research'
import type { sourcesCites } from './research'
import type { Numbering } from './research'
import { GAP as TABLE_GAP, cellAlign, cellLines, clipRuns, headerAlign, numberTable, padding, streamLayout } from './table'
import type { Drawn, Frozen } from './table'
import { stripNoise } from './testsummary'
import { commandNotice, fitParts, frameLabel, frameRow, partsWidth, planLine, tasksFrame } from './states'
import type { Part } from './states'

// Session state (survives a reload). Change a shape tag when its fields change.
const prompts = atom({ plugin: 'ghostframe', key: 'prompts' } as const, [] as PromptStamp[], { shape: 'prompts-1' })
// Every finished main-loop turn: its close rule finds its own by duration.
const closes = atom({ plugin: 'ghostframe', key: 'closes' } as const, [] as TurnClose[], { shape: 'closes-1' })
const SAME_TURN_MS = 250
// What the turn used before its first visible block, then what each turn's opener carries.
const caps = atom({ plugin: 'ghostframe', key: 'caps' } as const, NO_CAPS, { shape: 'caps-1' })
const openers = atom({ plugin: 'ghostframe', key: 'openers' } as const, [] as OpenerCaps[], { shape: 'openers-2' })
// What the whole turn used, for the close rule's tally.
const tally = atom({ plugin: 'ghostframe', key: 'tally' } as const, NO_TALLY, { shape: 'tally-1' })
// Assistant blocks in stored order, so a block knows what sits right above it.
const flow = atom({ plugin: 'ghostframe', key: 'flow' } as const, [] as FlowStamp[], { shape: 'flow-1' })
// Read off shell calls as they end: test counts and what was shipped, by call id.
const testRuns = atom({ plugin: 'ghostframe', key: 'testRuns' } as const, [] as TestRunStamp[], { shape: 'testRuns-1' })
const ships = atom({ plugin: 'ghostframe', key: 'ships' } as const, [] as ShipStamp[], { shape: 'ships-1' })
// Each main-loop tool call: its turn, start, and how long it ran (null while running).
const steps = atom({ plugin: 'ghostframe', key: 'steps' } as const, [] as StepStamp[], { shape: 'steps-1' })
const currentTurn = atom({ plugin: 'ghostframe', key: 'turn' } as const, null as string | null, { shape: 'turn-1' })
// The opening text of each turn's first prose block, so `claude` labels only that block.
const firstTexts = atom({ plugin: 'ghostframe', key: 'firstTexts' } as const, [] as FirstText[], { shape: 'firstTexts-2' })
const awaitingFirst = atom({ plugin: 'ghostframe', key: 'awaitingFirst' } as const, false, { shape: 'awaitingFirst-1' })
// The first tool call of each turn that opened on tools, so its activity header carries `claude`.
const firstTools = atom({ plugin: 'ghostframe', key: 'firstTools' } as const, [] as string[], { shape: 'firstTools-1' })
const STEPS_MAX = 400
const FLOW_MAX = 600
const OPENERS_MAX = 300
const FIRSTS_MAX = 500

/**
 * A turn-keyed list cut back to `max` entries a whole turn at a time, oldest first, so an
 * old row never loses part of its turn on a redraw. `current`'s turn is never cut.
 */
// shortcut: one filter pass per dropped turn, and a current turn longer than `max` stays
// whole; fine at caps of a few hundred, batch the cut if a cap grows to many thousands.
const capTurns = <T extends { turn?: string | null | undefined }>(list: T[], max: number, current: string | null | undefined): T[] => {
  let out = list

  while (out.length > max && out[0] !== undefined && out[0].turn !== current) {
    const oldest = out[0].turn

    out = out.filter(x => x.turn !== oldest)
  }

  return out
}
// True while a main-loop turn runs: tables keep their columns until it completes.
const streaming = atom({ plugin: 'ghostframe', key: 'streaming' } as const, false, { shape: 'streaming-1' })
// Each streamed table's frozen columns; a reply taller than the window keeps them for good.
// Written while drawing, which $.state refuses, so it lives here. Widths only, never lines.
// A reload (or an evicted entry) costs that table one re-flow.
const frozen = new Map<string, Frozen>()
const FROZEN_MAX = 2000
// Each outcome card's lines as first drawn complete, by call and measure: a card, once
// on screen, never changes (§6, streaming stability). A card that gives way to a later
// run's simply stops drawing. Written while drawing, so it lives here, like `frozen`.
const cardLines = new Map<string, Part[][][]>()
const CARDS_MAX = 300
// The calls whose result row drew a frame (a card, the task list) as last drawn, so the
// prose under one knows its own blank row is already there. Written while drawing.
const framedCalls = new Map<string, true>()
const FRAMED_MAX = 2000
// Each reply block's top gap, fixed the first time it draws (§6: a drawn row never moves).
const replyGaps = new Map<string, number>()
// The message each reply draw belongs to, so a remount keeps what its first draw decided.
// The engine may mount a message again when its turn ends (a new request for the same
// message); keyed by request alone, that draw would lay its table out afresh and pick its
// gap again. A new request whose text names a message drawn earlier in the same turn takes
// that message's request: its frozen table layouts and gap. Written while drawing.
const drawnMessages = new Map<string, { key: string; turn: string | null }>()
const sameMessage = new Map<string, string>()
const messageOf = (request: string, key: string, turn: string | null) => {
  const had = sameMessage.get(request)

  if (had !== undefined) return had

  let owner = request

  for (const [r, m] of drawnMessages) {
    if (r !== request && m.turn === turn && sameKey(m.key, key)) owner = sameMessage.get(r) ?? r
  }

  remember(sameMessage, request, owner, 2000)

  return owner
}
const GAPS_MAX = 2000

// Least recently remembered goes first: a key written again moves to the newest end.
const remember = <K, V>(m: Map<K, V>, k: K, v: V, max: number) => {
  m.delete(k)
  m.set(k, v)

  while (m.size > max) {
    const oldest = m.keys().next().value

    if (oldest === undefined) break
    m.delete(oldest)
  }
}

function frozenCard(key: string, ready: boolean, make: () => Part[][][]): Part[][][] {
  const held = cardLines.get(key)

  if (held !== undefined) return held

  const lines = make()

  if (ready) remember(cardLines, key, lines, CARDS_MAX)

  return lines
}
// Which submit stamp each turn rule shows, by the row's request: the same prompt typed
// twice has two stamps. A row keeps the stamp it claimed. A first draw takes the submit
// that just landed when it is free (the row the engine draws for it), else the oldest
// stamp no other row holds (rows redrawn in transcript order after a reload), so an
// earlier rule never takes a later submit's time. Written while drawing.
// shortcut: an older row with the same text that first draws after a reload, between a
// submit and its own row, takes that submit; the new row then shows the older time.
const promptClaims = new Map<string, number>()
// Rows each claim map remembers, oldest dropped first.
const CLAIMS_MAX = 500
// The stamp of the prompt submitted last: its turn rule is the next one the engine draws.
let lastSubmitted: number | undefined
// The same stamp, until a main-loop turn takes it as its start (Cockpit's turn clock).
let unclaimedSubmit: number | undefined
const claimPrompt = (row: string, text: string, list: readonly PromptStamp[]) => {
  const same = list.filter(p => p.text.trim() === text.trim())
  const held = promptClaims.get(row)
  const kept = held === undefined ? undefined : same.find(p => p.at === held)

  if (kept !== undefined) return kept

  const taken = new Set([...promptClaims.entries()].filter(([r]) => r !== row).map(([, at]) => at))
  const free = same.filter(p => !taken.has(p.at))
  const pick = free.find(p => p.at === lastSubmitted) ?? free[0]

  if (pick !== undefined) remember(promptClaims, row, pick.at, CLAIMS_MAX)

  return pick
}
// Main-loop calls whose permission check asked the person, until the call returns.
const asked = atom({ plugin: 'ghostframe', key: 'asked' } as const, [] as string[], { shape: 'asked-1' })

/** A block's identity for first-of-turn matching: whitespace folded, first 100 chars. */
const firstKey = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 100)
/** Two block keys name the same block: equal, or one (≥ 20 chars) a prefix of the other while it streams. */
const sameKey = (x: string, k: string) => k.length > 0 && (x === k || (k.length >= 20 && x.startsWith(k)) || (x.length >= 20 && k.startsWith(x)))
/**
 * Whether an entry recorded under `entry` belongs to a block placed in `turn`: the same
 * turn, or either side unknown (a block not in the flow, an opener seeded from history).
 */
// A block with no place in the turn's flow (a summary row): it may match any turn's opener.
const ANY_TURN = undefined
const inTurn = (entry: string | null | undefined, turn: string | null | undefined) => entry === undefined || turn === undefined || entry === turn
const isTurnOpener = (list: readonly FirstText[], text: string, turn: string | null | undefined) => {
  const k = firstKey(text)

  return list.some(x => inTurn(x.turn, turn) && sameKey(x.key, k))
}

/**
 * Where a block sits in the turn's flow: its own index, or, while the turn runs and
 * the block isn't stored yet, the end (it's the newest). Unknown → undefined.
 */
const flowPlace = (list: readonly FlowStamp[], find: (f: FlowStamp) => boolean, live: boolean, turn: string | null) => {
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i]

    if (f !== undefined && find(f)) return { at: i, turn: f.turn }
  }

  return live ? { at: list.length, turn } : undefined
}

/**
 * The sources a turn's text blocks cited before index `before` (all of them when
 * omitted), in first-cited order: what numbers the next block's markers continue from.
 * A Sources list naming one again keeps its own title.
 */
const turnCites = (list: readonly FlowStamp[], turn: string | null, before = list.length) => {
  const out: { url: string; title: string; listed?: boolean; marked?: boolean }[] = []

  for (const f of list.slice(0, before)) {
    if (f.turn !== turn || f.kind !== 'text') continue

    for (const c of f.cites ?? []) {
      const at = out.findIndex(x => x.url === c.url)
      const had = out[at]

      if (had === undefined) out.push({ ...c })
      else out[at] = { ...had, ...(c.listed === true ? { title: c.title, listed: true } : {}), ...(c.marked === true ? { marked: true } : {}) }
    }
  }

  return out
}

/** How many browser calls the block closes the frame of (0: none open above it). */
const browserOpenAbove = (list: readonly FlowStamp[], place: { at: number; turn: string | null } | undefined) =>
  place === undefined ? 0 : openRunBefore(list, place.at, place.turn)

// The session's folder, for relative paths; set again by session.start on every (re)load.
let cwd: string | undefined
// The main-loop turn that completed last: its footer row is the next one the engine draws.
let lastClosed: string | undefined

// Tools whose result rows we draw (the step row already carries the result).
const OWN = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Write',
  'Bash',
  'PowerShell',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TodoWrite',
  'Skill',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'TaskCreate',
  'TaskUpdate'
])
const OWN_RESULT = (tool: string) => OWN.has(tool) || mcpName(tool) !== undefined

const WARNING = /paused|warn|limit|low|error|fail|denied|stale/i

function durationLabel(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

type Content = ReadonlyArray<{ type: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown }>

// Each stored assistant block, in order, under the current turn; cited links count as sources.
async function noteFlow($: EngineInterface, content: Content) {
  const turn = await read($, currentTurn)
  const items: FlowStamp[] = []
  const links: string[] = []
  const earlier = turnCites(await read($, flow), turn)

  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      const { own } = citationsOf(splitBlocks(b.text), earlier)

      items.push({ turn, kind: 'text', key: firstKey(b.text), ...(own.length > 0 ? { cites: own } : {}) })
      earlier.push(...own.filter(c => !earlier.some(x => x.url === c.url)))
      links.push(...own.map(c => c.url))
    } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      items.push({ turn, kind: 'tool', key: b.id, tool: b.name })
    }
  }

  if (items.length > 0) await update($, flow, list => capTurns([...list, ...items], FLOW_MAX, turn))
  if (links.length > 0) await update($, tally, t => ({ ...t, sources: [...new Set([...t.sources, ...links])] }))
}

// The opener fixes its capability line now: what the turn used so far, plus the skills
// and MCP servers its own message calls. Later use goes to the close rule's tally.
// Thinking under `claude` (§5.11): on a work turn, or past 10s on any turn. Whether the
// turn works is known at its opener only when the opener is a tool call or its message
// holds one; a turn that opens on prose shows its thinking only past 10s, so the line
// above never changes once tools follow.
const THOUGHT_ALWAYS_MS = 10_000

async function snapshotCaps($: EngineInterface, key: string, turn: string | null, content: Content, opensOnTool: boolean) {
  // Taken and reset in one write: a hook or skill noted meanwhile is never lost between them.
  let c = NO_CAPS

  await update($, caps, held => {
    c = held

    return NO_CAPS
  })

  const isWork = opensOnTool || content.some(b => b.type === 'tool_use')

  if (!isWork && c.thoughtMs < THOUGHT_ALWAYS_MS) c = { ...c, thoughtMs: 0 }

  for (const b of content) {
    if (b.type !== 'tool_use' || typeof b.name !== 'string') continue

    const skill = b.name === 'Skill' && isObject(b.input) ? b.input['skill'] : undefined
    const server = mcpName(b.name)?.[0]

    if (typeof skill === 'string') c = withSkill(c, skill)
    if (server !== undefined) c = withMcp(c, server.replace(/^claude_ai_/, ''))
  }

  const snapped = c

  if (hasCaps(snapped)) await update($, openers, list => capTurns([...list, { key, turn, caps: snapped }], OPENERS_MAX, turn))
}

// What a finished main-loop call adds to the turn: the tally, test counts, what shipped.
async function afterCall(
  $: EngineInterface,
  e: { tool: string; tool_use_id: string },
  ran: { result?: unknown; text?: string | undefined; deny?: string | undefined }
) {
  if (ran.deny !== undefined) return

  const tool = e.tool
  const str = (k: string) => {
    const v: unknown = Reflect.get(e, k)

    return typeof v === 'string' ? v : undefined
  }
  const path = str('file_path') ?? str('notebook_path')
  const isShell = tool === 'Bash' || tool === 'PowerShell'
  const command = isShell ? (str('command') ?? '') : ''
  const out = shellText(ran.result)
  const text = out.trim().length > 0 ? out : (ran.text ?? '')
  const runner = isShell ? runnerOf(command) : undefined
  const counts = runner === undefined ? undefined : parseTests(text)
  const ship = isShell && isShipCommand(command) ? parseShip(e.tool_use_id, command, text) : undefined
  const skill = tool === 'Skill' ? str('skill') : undefined

  await update($, tally, t => ({
    ...t,
    agents: t.agents + (tool === 'Agent' || tool === 'Task' ? 1 : 0),
    browser: t.browser + (browserTool(tool) !== undefined ? 1 : 0),
    files: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool) && path !== undefined && !t.files.includes(path) ? [...t.files, path] : t.files,
    skills: skill !== undefined && !t.skills.includes(skillName(skill)) ? [...t.skills, skillName(skill)] : t.skills,
    tests: t.tests + (counts !== undefined ? 1 : 0),
    shipped: t.shipped + (ship !== undefined ? 1 : 0)
  }))

  const turn = runner !== undefined || ship !== undefined ? await read($, currentTurn) : null

  if (runner !== undefined && counts !== undefined) {
    await update($, testRuns, list => [...list, { id: e.tool_use_id, turn, runner, ...counts }].slice(-100))
  }

  if (ship !== undefined) {
    await update($, ships, list => [...list, { ...ship, turn }].slice(-100))
  }
}

// The capability line a turn's opener carries (by its text key or its first call's id).
async function openerCaps($: EngineInterface, match: (o: OpenerCaps) => boolean, width: number) {
  const found = (await read($, openers)).toReversed().find(match)

  return found === undefined ? undefined : capsLine(found.caps, width)
}

// Settings hooks that decided something (allowed, blocked, added context): the engine
// names the event, not the hook, so the line says `hook PreToolUse allowed`. Observes
// only; never re-runs a hook (no .catch: a failure here keeps the answer heard).
async function noteHook($: EngineInterface, event: string, result: unknown, agentId: unknown) {
  const said = agentId === undefined ? hookOutcome(event, result) : undefined

  if (said === undefined) return

  await update($, caps, c => withHook(c, said))
  await update($, tally, t => ({ ...t, hooks: t.hooks + 1 }))
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// User rows the engine writes itself (a slash command's echo, its output, a reminder, a
// task notice, a `!` shell): no typed prompt. `$.session.messages()` rows carry no origin,
// so the known tags are the test; a prompt that starts with any other `<` is the person's.
const INJECTED = /^\s*<(command-|local-command|system-reminder|task-notification|bash-|user-prompt-submit-hook)/

const RELOADED = /^\s*([\w.@/-]+): reloaded \((\d+) hooks?\b[^)]*\)\s*$/

/** A plugin's hot-reload note, shortened; anything else → undefined (left as it came). */
function reloadNote<M extends { content: unknown }>(message: M): M | undefined {
  const c = message.content
  const first: unknown = Array.isArray(c) && c.length === 1 ? c[0] : undefined
  const block = isObject(first) ? first : undefined
  const text = typeof c === 'string' ? c : block?.['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : undefined
  const m = text === undefined ? null : RELOADED.exec(text)

  if (m === null) return undefined

  const n = Number(m[2])
  const short = `${m[1]} reloaded · ${n} ${n === 1 ? 'hook' : 'hooks'}`

  return { ...message, content: typeof c === 'string' ? short : [{ ...block, text: short }] }
}

type Cites = ReturnType<typeof sourcesCites>
type Prepared = { title?: string | undefined; items: { depth: number; marker: string; runs: Run[]; cites: Cites }[]; cites: Cites }

/**
 * Sources cited earlier in the turn, as `noteFlow` stored them: first-cited order.
 * `listed`: named in a Sources list. `marked`: a drawn block carries its marker.
 */
type TurnCite = { url: string; title: string; listed?: boolean; marked?: boolean }

/**
 * One pass over a reply's blocks: each block's runs and the sources it cites, numbered
 * through the turn (`earlier`: what the turn's earlier messages cited, in order), and
 * every source the turn cites so far (by number; a Sources list's title wins).
 * The reply draws from it and the close rule counts from it, so the two always agree.
 * Only blocks the mod draws itself cite anything: a block left to the engine (a table or
 * paragraph we can't parse) never numbers a source, so it can't leave a footnote behind.
 */
function citationsOf(blocks: readonly Block[], earlier: readonly TurnCite[] = []) {
  const numbering: Numbering = new Map()
  const byNumber = new Map<number, Cites[number] & { listed?: boolean; marked?: boolean }>()
  const touched = new Set<number>()
  const note = (c: Cites[number], how: { listed?: boolean; marked?: boolean }, mine = true) => {
    const had = byNumber.get(c.n)
    const listed = how.listed === true || had?.listed === true
    const marked = how.marked === true || had?.marked === true
    // A Sources list's title wins over a link's text.
    const title = had === undefined || (how.listed === true && had.listed !== true) ? c.title : had.title

    if (mine) touched.add(c.n)
    byNumber.set(c.n, { n: c.n, url: c.url, title, ...(listed ? { listed } : {}), ...(marked ? { marked } : {}) })
  }

  // Sources a Sources list names but no drawn marker cites: in the frame, without a number.
  const listedOnly = new Map<string, TurnCite>()

  for (const c of earlier) {
    // Only a marker takes a number (§0.2: every number in the frame is on screen).
    if (c.marked !== true) {
      listedOnly.set(c.url, c)
      continue
    }
    if (!numbering.has(c.url)) numbering.set(c.url, numbering.size + 1)
    note({ n: numbering.get(c.url) ?? 0, url: c.url, title: c.title }, c, false)
  }

  // Numbers the turn's earlier messages already gave (and framed, in a web turn).
  const earlierNumbers = numbering.size
  const cited = new Map<Block, { runs?: Run[]; cites: Cites; byTitle: boolean; unmarked?: TurnCite[] }>()
  const lists = new Map<Block, Prepared>()
  // Tables with links: renumbered through the turn, and the sources they cite.
  const tables = new Map<Block, { block: Extract<Block, { kind: 'table' }>; cites: Cites }>()

  for (const b of blocks) {
    if (b.kind === 'cited') {
      const c = parseCited(b.text, numbering)

      if (c !== undefined) cited.set(b, { ...c, byTitle: false })
      for (const x of c?.cites ?? []) note(x, { marked: true })
    } else if (b.kind === 'table') {
      // A partial table's complete rows number first: they are the prefix of the whole.
      const whole = numberTable(b.table, numbering)
      const settled = b.settled === undefined ? undefined : numberTable(b.settled, new Map(numbering)).table

      if (whole.cites.length > 0) {
        tables.set(b, { block: { ...b, table: whole.table, ...(settled !== undefined ? { settled } : {}) }, cites: whole.cites })
        for (const x of whole.cites) note(x, { marked: true })
      }
    } else if (b.kind === 'list') {
      const cites: Cites = []
      const items = b.items.map(it => {
        // The streaming last item: plain text, marks dropped, until it parses.
        if (it.loose === true) return { ...it, runs: [{ t: it.text.replace(/[*_`[\]<>]/g, ''), s: 'plain' as const }], cites: [] }

        const c = parseCited(it.text, numbering)

        for (const x of c?.cites ?? []) {
          if (!cites.some(y => y.n === x.n)) cites.push(x)
          note(x, { marked: true })
        }

        return { ...it, runs: c?.runs ?? parseInline(it.text) ?? [{ t: it.text, s: 'plain' as const }], cites: c?.cites ?? [] }
      })

      lists.set(b, { title: b.title, items, cites })
    }
  }

  // Sources lists last: numbers follow the markers in reading order, wherever the list
  // sits; an item no marker cites keeps no number.
  const ownListed: TurnCite[] = []

  for (const b of blocks) {
    if (b.kind !== 'sources') continue

    const cites: Cites = []
    const unmarked: TurnCite[] = []

    for (const it of b.items) {
      const n = numbering.get(it.url)

      if (n === undefined) {
        const entry = { url: it.url, title: it.title, listed: true }

        if (!listedOnly.has(it.url)) listedOnly.set(it.url, entry)
        if (!ownListed.some(x => x.url === it.url)) ownListed.push(entry)
        if (!unmarked.some(x => x.url === it.url)) unmarked.push(entry)
      } else if (!cites.some(c => c.n === n)) {
        cites.push({ n, url: it.url, title: it.title })
        note({ n, url: it.url, title: it.title }, { listed: true })
      }
    }

    cited.set(b, { cites, byTitle: true, unmarked })
  }

  // A source an earlier list named and this message marks: numbered now, not listed-only.
  for (const url of numbering.keys()) listedOnly.delete(url)

  const sorted = [...byNumber.values()].toSorted((a, b) => a.n - b.n)
  const sources = sorted.map(({ n, url, title }) => ({ n, url, title }))
  // Every source this message cites, for its flow stamp (flags kept).
  const own: TurnCite[] = [...sorted.filter(c => touched.has(c.n)).map(({ n: _, ...c }) => c), ...ownListed.filter(c => listedOnly.has(c.url))]
  // Every source the turn has cited or listed so far, flags merged.
  const all: TurnCite[] = [...sorted.map(({ n: _, ...c }) => c), ...listedOnly.values()]

  // What this message adds to the turn: its frame, in a web turn. A source an earlier
  // message already numbered or listed is in that message's frame, not again here.
  const mine = sources.filter(c => touched.has(c.n) && c.n > earlierNumbers)
  const mineListed = ownListed.filter(c => listedOnly.has(c.url) && !earlier.some(x => x.url === c.url))

  return { cited, lists, tables, sources, own, all, mine, mineListed, listsHere: ownListed.length > 0 }
}

// A reply redraws on every state change; its blocks and citations change only with its
// text and what the turn cited above it. Held per text and per request, bounded.
const MEMO_MAX = 200
const blockMemo = new Map<string, Block[]>()
const citeMemo = new Map<string, { blocks: readonly Block[]; out: ReturnType<typeof citationsOf> }>()

function blocksOf(text: string): Block[] {
  const blocks = blockMemo.get(text) ?? splitBlocks(text)

  remember(blockMemo, text, blocks, MEMO_MAX)

  return blocks
}

// Keyed by the request and what came before; the blocks themselves (one text's, by
// identity) must match too, since the result's maps are keyed by block.
function citationsFor(request: string, blocks: readonly Block[], earlier: readonly TurnCite[]) {
  const key = `${request}␟${JSON.stringify(earlier)}`
  const had = citeMemo.get(key)
  const out = had !== undefined && had.blocks === blocks ? had.out : citationsOf(blocks, earlier)

  remember(citeMemo, key, { blocks, out }, MEMO_MAX)

  return out
}

/** The tools that fetch from the web: a turn using one draws [ SOURCES ] frames (§0.2). */
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const isWebTool = (tool: string | undefined) => tool !== undefined && WEB_TOOLS.has(tool)

const isBrowserTool = (tool: string | undefined) => tool !== undefined && browserTool(tool) !== undefined

/** Whether the block right above a call in its turn is prose (narration): §0.2 wants a blank row. */
const afterNarration = (list: readonly FlowStamp[], place: { at: number; turn: string | null } | undefined) => {
  const prev = place !== undefined && place.at > 0 ? list[place.at - 1] : undefined

  return prev !== undefined && prev.kind === 'text' && prev.turn === place?.turn
}

const strip = (v: unknown) => (typeof v === 'string' ? stripNoise(v) : v)

/**
 * A shell's output without the engine's own notes (`Shell cwd was reset to …`), for
 * the engine's drawing of it (ctrl+o, background tasks). Same shape, so it still fits
 * the tool's schema; nothing to drop, or any other tool → the output as it was.
 */
function quietOutput(tool: string, output: unknown): unknown {
  if ((tool !== 'Bash' && tool !== 'PowerShell') || !isObject(output)) return output

  const o = output

  if (strip(o['stdout']) === o['stdout'] && strip(o['stderr']) === o['stderr']) return output

  return { ...o, stdout: strip(o['stdout']), stderr: strip(o['stderr']) }
}

/** A row's render event as the engine should draw it: its output quieted (`quietOutput`), else the event itself. */
const quietEvent = <E extends { props: { tool: string; output?: unknown } }>(e: E): E => {
  const output = quietOutput(e.props.tool, e.props.output)

  return output === e.props.output ? e : { ...e, props: { ...e.props, output } }
}

// One block on the grid. Wide: a 12-column gutter holds `label` beside the content.
// Narrow (§4): `label` is a caption line above, the content inset 2 at full width.
type Label = { text: string; color: string }

const cell = (ui: Ui, lay: Lay, label: Label | undefined, body: RenderChildren, marginTop = 0, key?: string) => {
  const { Box, Text } = ui
  const text = label?.text ?? ''
  const content = (
    <Box flexDirection="column" width={lay.width} flexShrink={1} minWidth={0}>
      {body}
    </Box>
  )

  if (lay.narrow) {
    return (
      <Box {...(key !== undefined ? { key } : {})} flexDirection="column" marginTop={marginTop}>
        {text.length > 0 && <Text color={label?.color ?? C.accent}>{text}</Text>}
        <Box flexDirection="row" flexWrap="nowrap" paddingLeft={lay.gutter}>
          {content}
        </Box>
      </Box>
    )
  }

  return (
    <Box {...(key !== undefined ? { key } : {})} flexDirection="row" flexWrap="nowrap" marginTop={marginTop}>
      <Box width={lay.gutter} flexShrink={0}>
        <Text color={label?.color ?? C.accent}>{text}</Text>
      </Box>
      {content}
    </Box>
  )
}

const claude = (shown: boolean): Label | undefined => (shown ? { text: 'claude', color: C.accent } : undefined)

const tableLines = ({ table: t, layout: tableLayout, airy: mayAir }: Drawn): Span[][] => {
  const { widths, hidden } = tableLayout
  const total = widths.reduce((a, b) => a + b, 0) + TABLE_GAP * (widths.length - 1)

  type DrawnCell = { runs: Run[]; color: string; empty: boolean }

  // A row is as tall as its tallest cell; the others are top-aligned.
  const rowLines = (cells: DrawnCell[], isHeader: boolean): Span[][] => {
    const per = widths.map((w, ci) => {
      const drawnCell = cells[ci] ?? { runs: [], color: C.text, empty: true }

      return cellLines({ runs: drawnCell.runs, empty: drawnCell.empty }, w, isHeader ? 'fixed' : (t.kind[ci] ?? 'fixed'))
    })
    const height = Math.max(1, ...per.map(p => p.length))

    return Array.from({ length: height }, (_, li) =>
      widths.flatMap((w, ci) => {
        const drawnCell = cells[ci]
        const runs = per[ci]?.[li] ?? []
        const column = t.align[ci] ?? 'left'
        const [l, r] = padding(runs, w, isHeader ? headerAlign(t, ci) : cellAlign(drawnCell, column))
        const tail = ci < widths.length - 1 ? r + TABLE_GAP : 0
        const base = drawnCell?.empty ? C.dim : (drawnCell?.color ?? C.text)

        return [...(l > 0 ? [{ t: ' '.repeat(l), color: C.text }] : []), ...spansOf(runs, base), ...(tail > 0 ? [{ t: ' '.repeat(tail), color: C.text }] : [])]
      })
    )
  }

  const header = rowLines(
    t.header.map(h => ({ runs: [{ t: h, s: 'plain' as const }], color: C.muted, empty: false })),
    true
  )
  const body = t.rows.map(cells =>
    rowLines(
      cells.map((c, ci) => ({ ...c, color: ci === 0 && t.nameFirst ? C.textBright : C.text })),
      false
    )
  )
  // A blank line between rows when rows wrap (§5.18), at any width. Settled (the turn
  // done, the reply re-flowed): between every two rows once any row wraps. Streaming or
  // frozen: next to each row that wraps, so a blank row only ever lands below a row
  // already drawn, or above the row being written.
  const wraps = body.map(r => r.length > 1)
  const anyWraps = wraps.some(w => w)
  const gapBefore = (ri: number) => ri > 0 && (mayAir ? anyWraps : wraps[ri] === true || wraps[ri - 1] === true)

  return [
    ...header,
    [{ t: '─'.repeat(total), color: C.hairline }],
    ...body.flatMap((r, ri) => (gapBefore(ri) ? [[], ...r] : r)),
    ...(hidden > 0 ? [[{ t: `${hidden} ${hidden === 1 ? 'column' : 'columns'} hidden`, color: C.dim }]] : [])
  ]
}

// A list's top-level runs of one marker kind (bullets, numbers), each with the sources
// its own items cite: a footnote line goes right under the run that holds its markers.
const listGroups = (p: Prepared): Prepared[] => {
  const groups: Prepared[] = []

  for (const it of p.items) {
    const last = groups[groups.length - 1]
    const head = last?.items.find(x => x.depth === 0)
    const same = last !== undefined && (it.depth > 0 || head === undefined || (head.marker === '·') === (it.marker === '·'))

    if (same && last !== undefined) last.items.push(it)
    else groups.push({ title: groups.length === 0 ? p.title : undefined, items: [it], cites: [] })
  }

  for (const g of groups) {
    for (const c of g.items.flatMap(x => x.cites)) if (!g.cites.some(y => y.n === c.n)) g.cites.push(c)
  }

  return groups
}

// One step row in the content column: `● verb    target ……… result   time`, then `╰─ detail`.
const drawStep = (ui: Ui, step: Step, time: string, width: number, key: string) => {
  const { Box, Text } = ui
  const l = layoutStep(step, time, width)

  return (
    <Box key={key} flexDirection="column">
      <Text wrap="truncate">
        <Text color={step.dot.color}>{`${step.dot.text} `}</Text>
        <Text color={C.muted}>{l.verb}</Text>
        <Text color={step.targetColor ?? C.textBright}>{l.target}</Text>
        <Text>{l.gap}</Text>
        {step.result.flatMap((r, i) => [
          ...(i > 0 ? [<Text key={`rs${i}`}> </Text>] : []),
          <Text key={`r${i}`} color={r.color}>
            {r.text}
          </Text>
        ])}
        <Text color={C.muted}>{l.timeCell}</Text>
      </Text>
      {l.detail !== undefined && (
        <Text wrap="truncate">
          <Text color={C.dim}>{G.hang}</Text>
          <Text color={C.dim}>{`${' '.repeat(VERB_W)}${l.detail}`}</Text>
        </Text>
      )}
    </Box>
  )
}

// `activity ┄┄┄┄┄┄┄┄┄┄┄┄┄ 6 steps · 41s`, the mini rule over a turn's first step.
const drawActivityRule = (ui: Ui, label: string) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" flexWrap="nowrap" width="100%" height={1} marginBottom={1}>
      <Box flexShrink={0}>
        <Text color={C.muted}>{'activity '}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
        <Text color={C.hairline} wrap="wrap">
          {G.hEdge.repeat(600)}
        </Text>
      </Box>
      {label.length > 0 && (
        <Box flexShrink={0}>
          <Text color={C.muted}>{` ${label}`}</Text>
        </Box>
      )}
    </Box>
  )
}

const stepTime = (list: readonly StepStamp[], id: string | undefined) => {
  const ms = list.find(s => s.id === id)?.ms

  return ms === null || ms === undefined ? '' : fmtDuration(ms)
}

// Wraps step rows in the gutter grid, under the activity rule when this opens the turn's
// activity; `claude` in the gutter when the turn opened on tools. Never holds an engine node.
// `extra.close`: the bottom edge of a browser frame left open right above (N actions).
// `extra.caps`: the capability line under `claude`. `extra.gap`: a blank row above the
// body (a frame opening after plain steps).
type Extra = { close?: number | undefined; caps?: Part[] | undefined; gap?: boolean | undefined }

const inGrid = (ui: Ui, head: string | undefined, lay: Lay, body: RenderChildren, label = false, extra: Extra = {}) => {
  const { Box } = ui
  const closing = (extra.close ?? 0) > 0

  return (
    <Box flexDirection="column">
      {closing && closeRow(ui, lay, extra.close ?? 0)}
      {cell(
        ui,
        lay,
        claude(label),
        [
          ...(extra.caps !== undefined
            ? [
                <Box key="caps" marginBottom={1}>
                  {drawParts(ui, extra.caps, 'caps')}
                </Box>
              ]
            : []),
          ...(head !== undefined ? [<Box key="head">{drawActivityRule(ui, head)}</Box>] : []),
          <Box key="body" flexDirection="column">
            {body}
          </Box>
        ],
        head !== undefined || label || closing || extra.gap === true ? 1 : 0
      )}
    </Box>
  )
}

// `+┄┄┄…┄┄ 5 actions +`: closes the browser frame above, in the content column.
const closeRow = (ui: Ui, lay: Lay, actions: number) => {
  const { Box } = ui

  return (
    <Box flexDirection="row" flexWrap="nowrap" paddingLeft={lay.gutter}>
      <Box width={lay.width} flexShrink={1} minWidth={0}>
        {drawParts(ui, browserBottom(lay.width, actions), 'close')}
      </Box>
    </Box>
  )
}

// An engine-drawn row the timeline can't redraw (a folded group, an unknown tool): the
// activity rule and `claude` still draw, as siblings above it, and the engine's node is
// indented by a padded gutter Text so its dot lines up with the step dots. The node
// itself never sits under a Box that has a width.
const engineInGutter = (ui: Ui, node: RenderChildren, head: string | undefined, lay: Lay, label: boolean, extra: Extra = {}) => {
  const { Box, Text } = ui
  const closing = (extra.close ?? 0) > 0
  // The caps line takes the `claude` label's row; the head (or the node) follows. Narrow,
  // `claude` is always its own caption line, so it heads the column the same way.
  const capsFirst = label && extra.caps !== undefined
  const onHead = head !== undefined || capsFirst || (label && lay.narrow)

  return (
    <Box flexDirection="column">
      {closing && closeRow(ui, lay, extra.close ?? 0)}
      <Box flexDirection="column" marginTop={onHead || label || closing || extra.gap === true ? 1 : 0}>
        {onHead &&
          cell(ui, lay, claude(label), [
            ...(capsFirst
              ? [
                  <Box key="caps" marginBottom={head !== undefined ? 1 : 0}>
                    {drawParts(ui, extra.caps ?? [], 'caps')}
                  </Box>
                ]
              : []),
            ...(head !== undefined ? [<Box key="head">{drawActivityRule(ui, head)}</Box>] : [])
          ])}
        {label && !onHead ? (
          <Box flexDirection="row" flexWrap="nowrap">
            <Box flexShrink={0}>
              <Text color={C.accent}>{pad('claude', lay.gutter)}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {node}
            </Box>
          </Box>
        ) : (
          // Padding, not a spacer Text: a node that draws nothing leaves no blank row.
          <Box flexDirection="column" paddingLeft={lay.gutter}>
            {node}
          </Box>
        )}
      </Box>
    </Box>
  )
}

// One line of parts, never wrapped (every framed line is built exactly the frame's width).
// A part's `href` is never drawn. The engine's Link is an OSC 8 span only where it
// judges the terminal supports one; elsewhere (Windows Terminal, as seen) it draws the
// text, then the whole URL, which overruns the measure and pushes later footnotes off
// the line. A Text can't carry the escape itself (control characters are dropped), so
// the label alone is drawn: never the raw URL, at the cost of the click.
const drawParts = (ui: Ui, parts: readonly Part[], key: string) => {
  const { Text } = ui

  return (
    <Text key={key} wrap="truncate">
      {parts.length === 0
        ? ' '
        : parts.map((p, i) => (
            <Text key={`${i}`} color={p.color} {...(p.bold ? { weight: 'bold' as const } : {})}>
              {p.t}
            </Text>
          ))}
    </Text>
  )
}

// Frame pieces stacked with no margins (a frame drawn across several rows).
const drawRows = (ui: Ui, lines: readonly Part[][], key: string) => {
  const { Box } = ui

  return (
    <Box key={key} flexDirection="column">
      {lines.map((l, i) => drawParts(ui, l, `${key}${i}`))}
    </Box>
  )
}

const drawFrame = (ui: Ui, lines: readonly Part[][]) => {
  const { Box } = ui

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {lines.map((l, i) => drawParts(ui, l, `f${i}`))}
    </Box>
  )
}

// `+┄┄ [ path · +18 −4 ] ┄┄┄…┄┄ 22 lines +`, numbered rows, folded past 12 (§5.5).
const drawDiff = (ui: Ui, diff: NonNullable<ReturnType<typeof diffRows>>, width: number) => {
  const { Box, Text } = ui
  const inner = width - 4
  const MAX = 12
  const shown = diff.rows.length > MAX ? diff.rows.slice(0, MAX - 1) : diff.rows
  const more = diff.rows.length - shown.length
  const noW = Math.max(2, ...diff.rows.map(r => String(r.no ?? '').length))
  const meta = `${diff.rows.filter(r => r.kind !== 'gap').length} lines`
  const parts = changeParts(diff.adds, diff.dels)
  const { title, fill } = diffTop(width, relPath(diff.path, cwd), parts, meta)

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- captures `Text` from `ui` through JSX (`<Text>`), which the rule does not see
  const edge = (body: RenderChildren, k: string) => (
    <Text key={k} wrap="truncate">
      <Text color={C.hairline}>{`${G.vEdge} `}</Text>
      {body}
      <Text color={C.hairline}>{` ${G.vEdge}`}</Text>
    </Text>
  )

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text wrap="truncate">
        <Text color={C.ruleStrong}>{G.cross}</Text>
        <Text color={C.hairline}>{`${G.hEdge.repeat(2)} `}</Text>
        {frameLabel(title, [
          ...(parts.length > 0 ? [{ t: ' · ', color: C.muted }] : []),
          ...parts.flatMap((p, i) => [...(i > 0 ? [{ t: ' ', color: C.text }] : []), { t: p.text, color: p.color }])
        ]).map((p, i) => (
          <Text key={`l${i}`} color={p.color}>
            {p.t}
          </Text>
        ))}
        <Text color={C.hairline}>{` ${G.hEdge.repeat(fill)} `}</Text>
        <Text color={C.muted}>{meta}</Text>
        <Text color={C.hairline}> </Text>
        <Text color={C.ruleStrong}>{G.cross}</Text>
      </Text>
      {shown.map((r, i) => {
        if (r.kind === 'gap') {
          return edge(<Text color={C.dim}>{pad(`${' '.repeat(noW)}   ⋯`, inner)}</Text>, `d${i}`)
        }

        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '
        const color = r.kind === 'add' ? C.add : r.kind === 'del' ? C.del : C.text
        const body = pad(r.text.replace(/\t/g, '  '), inner - noW - 3)

        return edge(
          [
            <Text key="n" color={C.muted}>
              {pad(String(r.no ?? ''), noW, 'right')}
            </Text>,
            <Text key="s" color={color}>{` ${sign} `}</Text>,
            <Text key="b" color={color}>
              {body}
            </Text>
          ],
          `d${i}`
        )
      })}
      {more > 0 &&
        edge(
          [
            <Text key="m" color={C.dim}>{`${G.hEdge.repeat(2)} ${more} more lines ${G.hEdge.repeat(2)}  `}</Text>,
            <Text key="k" color={C.muted}>
              {pad('ctrl+o', inner - vw(`${G.hEdge.repeat(2)} ${more} more lines ${G.hEdge.repeat(2)}  `))}
            </Text>
          ],
          'more'
        )}
      <Text wrap="truncate">
        <Text color={C.ruleStrong}>{G.cross}</Text>
        <Text color={C.hairline}>{G.hEdge.repeat(width - 2)}</Text>
        <Text color={C.ruleStrong}>{G.cross}</Text>
      </Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  registerCockpit(on, options)

  // Mode labels at the right of the prompt footer: grid cells split by │.
  on('ui.render', { component: 'SessionMode' }, ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const modes = e.props.modes

    if (modes.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        {modes.map((mode, i) => (
          <Box key={`m${i}`}>
            {i > 0 && <Text color={C.rule}>{'   │   '}</Text>}
            <Text color={WARNING.test(mode) ? C.warn : C.text}>{mode}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  // --- Transcript restyle (terminal only). Any surprise falls through to next(e). ---

  // User prompt: peach rail over the full height, text verbatim. Task notifications get the tree look.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.text.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    if (e.props.origin.kind === 'task-notification') {
      const launched = /launched|started/i.test(e.props.text)
      const ms = e.props.task?.durationMs

      return (
        <Box flexWrap="nowrap">
          <Box flexShrink={0}>
            <Text color={launched ? C.accent : C.muted}>{'◇ '}</Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text color={C.text} wrap="truncate-end">
              {e.props.text.split('\n')[0] ?? ''}
            </Text>
          </Box>
          {ms !== undefined && (
            <Box flexShrink={0}>
              <Text color={C.muted}>{` · ${durationLabel(ms)}`}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const lay = layout(e.viewport?.columns)

    if (e.props.origin.kind !== 'composer' || lay === undefined) {
      return next(e)
    }

    const width = lay.width

    // Turn open rule with the submit time (dropped when we never saw the submit),
    // then `you` in the gutter and the message behind a ▎ rail on every row.
    const stamp = claimPrompt(e.requestId, e.props.text, await read($, prompts))
    const rows = wrapPlain(e.props.text, width - 2)
    const ui = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {/* §0.2: one blank row between the last turn's footer rule and this one. */}
        <Box marginTop={1}>{Rule(ui, stamp ? { text: fmtClock(stamp.at), color: C.muted } : undefined, undefined, ruleWidth(lay))}</Box>
        {cell(
          ui,
          lay,
          { text: 'you', color: C.text },
          // One Text for the whole message: rows pre-wrapped to the measure, joined by \n.
          <Text wrap="wrap">
            {rows.flatMap((row, i) => [
              ...(i > 0 ? ['\n'] : []),
              <Text key={`${i}.rail`} color={C.accent}>
                {G.rail}
              </Text>,
              <Text key={`${i}.text`} color={C.textBright}>{` ${row}`}</Text>
            ])}
          </Text>,
          1
        )}
      </Box>
    )
  })

  // Claude's prose: `claude` in the gutter on the first block of a reply, body on the
  // one measure. Plain paragraphs and headings are laid out here (exact widths, code
  // chips); anything else goes through the engine's Markdown, links and all.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const lay = layout(e.viewport?.columns)

    if (e.surface !== 'terminal' || e.props.text.trim().length === 0 || lay === undefined) {
      return next(e)
    }

    const width: number = lay.width

    // A summary of text written between tool calls: dim, in the content column, no bullet,
    // no full-width line. `claude` only if this summary stands for the turn's opening text.
    if (e.props.isSummary === true) {
      const sui = $.ui.resolve(e)
      const { Text } = sui
      const plain = e.props.text.replace(/\s+/g, ' ').trim()
      const rows = wrapPlain(plain, width)
      const key = plain.replace(/…$/, '').trim()
      const label = e.props.isFirstOfReply && key.length >= 20 && isTurnOpener(await read($, firstTexts), key, ANY_TURN) ? 'claude' : ''

      return cell(
        sui,
        lay,
        claude(label.length > 0),
        <Text color={C.dim} wrap="wrap">
          {rows.join('\n')}
        </Text>,
        1
      )
    }

    const blocks = blocksOf(e.props.text)

    if (blocks.length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text, Markdown } = ui

    // Footnote numbers run through the message in block order (§0.1 r7): an earlier
    // paragraph's numbers never change when a later one streams in.
    const live = await read($, streaming)
    const isOffScreen = e.props.onScreen === null
    const key = firstKey(e.props.text)
    const blocksSoFar = await read($, flow)
    const turnNow = await read($, currentTurn)
    // Its own key first: a later block that only starts like this one is another block.
    // A prefix (text still streaming) is looked for in the running turn only.
    const place =
      flowPlace(blocksSoFar, f => f.kind === 'text' && f.key === key, false, turnNow) ??
      flowPlace(blocksSoFar, f => f.kind === 'text' && (!live || f.turn === turnNow) && sameKey(f.key, key), live, turnNow)
    // This draw's message, across remounts (see `messageOf`).
    const message = messageOf(e.requestId, key, place?.turn ?? null)

    remember(drawnMessages, e.requestId, { key, turn: place?.turn ?? null }, 2000)
    // Numbers run through the turn, not just this message: a reply split over several
    // messages (prose, a list, a Sources list) numbers each source once.
    const earlier = place === undefined ? [] : turnCites(blocksSoFar, place.turn, place.at)
    const { cited, lists, tables, mine, mineListed, listsHere } = citationsFor(e.requestId, blocks, earlier)
    // §0.2 citations, decided once and the same on every draw, streaming or done: a turn
    // that used a web tool (search, fetch) before this message draws [ SOURCES ] frames and
    // no footnote lines; any other turn draws footnote lines under the blocks that hold the
    // markers. Read from the flow above this block, which never changes once the block
    // starts: nothing that streams in later (more links, a Sources list, the turn ending)
    // can turn footnote lines into a frame or back.
    const framed = place !== undefined && blocksSoFar.slice(0, place.at).some(f => f.turn === place.turn && f.kind === 'tool' && isWebTool(f.tool))
    // A message citing a source, or holding a Sources list (even one whose items no marker cites).
    const citesHere = listsHere || [...cited.values(), ...lists.values(), ...tables.values()].some(x => x.cites.length > 0)
    // Each citing message of a web turn ends with its own frame: what it cites, numbered
    // through the turn, then what its Sources list names with no marker. It grows only at
    // the message's own end while the message streams.
    const drawsFrame = framed && citesHere && mine.length + mineListed.length > 0

    // Every prose block, heading and table is ONE Text: its lines are laid out and clipped
    // here, then joined with `\n`, so a redraw while text streams replaces the block whole
    // and can never leave a stale sibling line behind. Keys come from block position.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- captures `Box` and `Text` from `ui` through JSX, which the rule does not see
    const drawLines = (lines: Span[][], lineKey: string, gap: number) => (
      <Box key={lineKey} marginTop={gap}>
        <Text wrap="wrap">
          {lines.flatMap((line, li) => [
            ...(li > 0 ? ['\n'] : []),
            ...line.map((s, k) => (
              <Text
                key={`${li}.${k}`}
                color={s.color}
                {...(s.bg !== undefined ? { backgroundColor: s.bg } : {})}
                {...(s.bold ? { weight: 'bold' as const } : {})}
                {...(s.italic === true ? { italic: true } : {})}
              >
                {s.t}
              </Text>
            ))
          ])}
        </Text>
      </Box>
    )

    // Tables keep their columns while the turn streams (see streamLayout): each is keyed by
    // this message, its place among the message's tables, the measure and its header.
    // Narration (§0.1 r8): prose a tool call follows in the same turn is dim; the turn's
    // final answer, and every plain Q&A reply, keeps normal text. Known once the next
    // call is stored, so only the block right above the newest one changes, and only
    // its colour, never its rows.
    const quiet = place !== undefined && blocksSoFar.slice(place.at + 1).some(f => f.turn === place.turn && f.kind === 'tool')
    const base = quiet ? C.dim : C.text
    const runsLine = (line: Run[][], room: number) =>
      spansOf(
        clipRuns(
          line.flatMap((word, wi) => (wi > 0 ? [{ t: ' ', s: 'plain' as const }, ...word] : word)),
          room
        ),
        base,
        quiet
      )

    // A list: `·` / `3.` muted, each item wrapped under its own text (a hanging indent),
    // nested lists 2 further in. Every item is laid out alone, so a finished item never
    // moves while a later one streams.
    // §0.2: a bulleted list running straight into a numbered one (or back) is two block
    // kinds, so one blank row where the top-level marker changes kind.
    const listLines = (p: Prepared): Span[][] => [
      ...(p.title !== undefined ? [[{ t: clip(p.title, width), color: quiet ? C.dim : C.textBright, bold: true }]] : []),
      ...p.items.flatMap((it, ii) => {
        const before = p.items
          .slice(0, ii)
          .toReversed()
          .find(x => x.depth === 0)
        const switched = it.depth === 0 && before !== undefined && (before.marker === '·') !== (it.marker === '·')
        const lead = ' '.repeat(it.depth * 2)
        const hang = vw(lead) + vw(it.marker) + 1
        const room = Math.max(8, width - hang)
        const rows = it.runs.length === 0 ? [[]] : wrapWords(toWords(it.runs), room)

        return [
          ...(switched ? [[] as Span[]] : []),
          ...rows.map((row, ri) => [{ t: ri === 0 ? `${lead}${it.marker} ` : ' '.repeat(hang), color: C.muted }, ...runsLine(row, room)])
        ]
      })
    ]
    let tableNo = 0
    const plans = blocks.flatMap(b => {
      if (b.kind !== 'table') return []

      const tableKey = `${message}|${tableNo++}|${width}|${b.table.header.join('␟')}`

      // A table with links lays out with its markers renumbered through the turn.
      return [{ b, src: tables.get(b)?.block ?? b, key: tableKey, held: frozen.get(tableKey) }]
    })
    const decide = (mayReflow: boolean) =>
      new Map(plans.map(p => [p.b as Block, { key: p.key, ...streamLayout(p.src, width, live, p.held, isOffScreen, mayReflow) }]))
    const drawsOf = (m: ReturnType<typeof decide>) => new Map([...m].map(([b, r]) => [b, r.drawn]))

    // A table keeps the layout it froze while streaming, when the turn ends too: no
    // re-flow at completion. (It used to re-flow when the reply alone fit the window, but
    // the region the terminal redraws also holds the turn rule, the prompt and the footer:
    // past the window's height the redraw printed the whole turn a second time.)
    const decided = decide(false)

    for (const { key: tableKey, hold } of decided.values()) {
      if (hold === undefined) {
        frozen.delete(tableKey)
      } else {
        remember(frozen, tableKey, hold, FROZEN_MAX)
      }
    }

    const tableDraws = drawsOf(decided)

    // Whether a block draws its footnote line: in any turn without web tools, always (the
    // line comes with its markers, from the block's first draw).
    const notesShown = (_key: string, n: number) => n > 0 && !framed

    const drawBlock = (b: Block, blockKey: string, gap: number) => {
      switch (b.kind) {
        case 'table': {
          const drawn = tableDraws.get(b)

          if (drawn === undefined) return null

          const lines = tableLines(drawn)
          // Only markers still on screen get an entry: a cell cut at its line limit (or
          // clipped narrow) can drop its marker, and a footnote never points at nothing.
          const shown = new Set(
            lines.flatMap(
              l =>
                l
                  .map(sp => sp.t)
                  .join('')
                  .match(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g) ?? []
            )
          )
          const notes = (tables.get(b)?.cites ?? []).filter(c => shown.has(sup(c.n)))

          if (notes.length === 0) return drawLines(lines, blockKey, gap)

          // Markers in the cells: the footnote line goes right under the table.
          return (
            <Box key={blockKey} marginTop={gap} flexDirection="column">
              {drawLines(lines, `${blockKey}-t`, 0)}
              {notesShown(blockKey, notes.length) && drawRows(ui, footnoteLines(notes, width), `${blockKey}-n`)}
            </Box>
          )
        }
        case 'heading':
          return drawLines([[{ t: clip(b.text, width), color: quiet ? C.dim : C.textBright, bold: true }]], blockKey, gap)
        case 'para':
          return drawLines(
            wrapWords(toWords(b.runs), width).map(line => runsLine(line, width)),
            blockKey,
            gap
          )
        // An mdxcn figure (§5.7): our frame at the measure; an artifact, never dimmed.
        case 'figure':
          return (
            <Box key={blockKey} marginTop={gap} flexDirection="column">
              {drawRows(ui, figureLines(b, width, lay.narrow), `${blockKey}-f`)}
            </Box>
          )
        case 'markdown':
          return (
            <Box key={blockKey} marginTop={gap} flexDirection="column">
              <Markdown text={b.text} dimColor={quiet} />
            </Box>
          )
        case 'list': {
          const p = lists.get(b)

          if (p === undefined) return null

          return (
            <Box key={blockKey} marginTop={gap} flexDirection="column">
              {listGroups(p).map((g, gi) => (
                <Box key={`${blockKey}-g${gi}`} marginTop={gi > 0 ? 1 : 0} flexDirection="column">
                  {drawLines(listLines(g), `${blockKey}-g${gi}-l`, 0)}
                  {notesShown(`${blockKey}-g${gi}`, g.cites.length) && drawRows(ui, footnoteLines(g.cites, width), `${blockKey}-g${gi}-n`)}
                </Box>
              ))}
            </Box>
          )
        }
        case 'cited':
        case 'sources': {
          const c = cited.get(b)

          if (c === undefined) {
            return b.kind === 'cited' ? (
              <Box key={blockKey} marginTop={gap} flexDirection="column">
                <Markdown text={b.text} dimColor={quiet} />
              </Box>
            ) : null
          }

          const body = c.runs === undefined ? [] : wrapWords(toWords(c.runs), width).map(line => runsLine(line, width))
          // A Sources list draws no numbered line of its own (its items have no markers). In a
          // web turn it is the frame. Otherwise its marked sources are on their blocks' lines
          // already, and any it names with no marker get one dim line, `·` for a number.
          if (b.kind === 'sources') {
            const rest = c.unmarked ?? []

            if (framed || rest.length === 0) return null

            return (
              <Box key={blockKey} marginTop={gap} flexDirection="column">
                {drawRows(
                  ui,
                  footnoteLines(
                    rest.map(r => ({ n: 0, url: r.url, title: r.title })),
                    width,
                    true
                  ),
                  `${blockKey}-n`
                )}
              </Box>
            )
          }

          return (
            <Box key={blockKey} marginTop={gap} flexDirection="column">
              {body.length > 0 && drawLines(body, `${blockKey}-p`, 0)}
              {notesShown(blockKey, c.cites.length) && drawRows(ui, footnoteLines(c.cites, width, c.byTitle), `${blockKey}-n`)}
            </Box>
          )
        }
        default:
          return null
      }
    }

    // Segments: runs of blocks in the gutter column, and `wide` engine tables at full width.
    type Segment = { wide: false; blocks: Block[] } | { wide: true; text: string }
    const segments: Segment[] = []

    for (const b of blocks) {
      const last = segments[segments.length - 1]

      if (b.kind === 'wide') {
        segments.push({ wide: true, text: b.text })
      } else if (last !== undefined && !last.wide) {
        last.blocks.push(b)
      } else {
        segments.push({ wide: false, blocks: [b] })
      }
    }

    // `claude` once per turn, on Claude's first visible block (isFirstOfReply is true after
    // every tool call too). A reply that opens on a wide table gets the label on its own row.
    // Matched within the block's own turn: prose that only starts like another turn's opener is not one.
    const isOpener = e.props.isFirstOfReply && isTurnOpener(await read($, firstTexts), e.props.text, place?.turn)
    // The capability line takes `claude`'s row; the reply follows a blank row below it.
    const capsRow = isOpener ? await openerCaps($, o => inTurn(o.turn, place?.turn) && sameKey(o.key, key), width) : undefined
    const label = isOpener && capsRow === undefined ? 'claude' : ''
    const opensWide = segments[0]?.wide === true
    // A browser frame left open right above this block: its bottom edge first.
    const above = browserOpenAbove(blocksSoFar, place)
    // One blank row above a reply block, the same after an activity row (●) as anywhere,
    // except right under a frame that drew its own (a card, the task list). Decided when
    // the block starts and kept: a card collapsing later never moves this block.
    const prev = place !== undefined && place.at > 0 ? blocksSoFar[place.at - 1] : undefined
    const held = replyGaps.get(message)
    const gap = held ?? (prev !== undefined && prev.kind === 'tool' && prev.turn === place?.turn && framedCalls.has(prev.key) ? 0 : 1)

    if (held === undefined) remember(replyGaps, message, gap, GAPS_MAX)

    return (
      <Box flexDirection="column">
        {above > 0 && closeRow(ui, lay, above)}
        <Box flexDirection="column" marginTop={gap}>
          {capsRow !== undefined && <Box marginBottom={1}>{cell(ui, lay, claude(true), drawParts(ui, capsRow, 'caps'))}</Box>}
          {(opensWide || lay.narrow) && label.length > 0 && <Text color={C.accent}>{label}</Text>}
          {segments.map((seg, si) =>
            seg.wide ? (
              <Box key={`seg-${si}`} marginTop={si > 0 || (opensWide && label.length > 0) ? 1 : 0} width="100%">
                <Markdown text={seg.text} />
              </Box>
            ) : (
              // Narrow: the label already stands as the caption line above.
              cell(
                ui,
                lay,
                claude(si === 0 && label.length > 0 && !lay.narrow),
                seg.blocks.map((b, i) => drawBlock(b, `blk-${si}-${i}`, i > 0 ? 1 : 0)),
                si > 0 ? 1 : 0,
                `seg-${si}`
              )
            )
          )}
          {/* §0.2: one blank row above the frame; none of its own when the reply's only block is the list it replaces (the reply's gap is that row). */}
          {drawsFrame &&
            cell(
              ui,
              lay,
              undefined,
              drawRows(ui, sourcesFrame(mine, width, mineListed), 'sources'),
              blocks.every(b => b.kind === 'sources') ? 0 : 1,
              'sources'
            )}
        </Box>
      </Box>
    )
  })

  // ─── Activity (§5.4 under §0.1 r1, r2, r14) ────────────────────────────────

  on('session.start', async ($, e, next) => {
    cwd = e.cwd

    // Seed turn openers from history (a resumed session, or the turns before a reload):
    // the first assistant text after each typed prompt.
    try {
      const found = await $.session.messages()

      if (Array.isArray(found)) {
        const keys: string[] = []
        let waiting = false

        const tools: string[] = []

        for (const m of found) {
          if (m.role === 'user' && m.text.trim().length > 0 && !INJECTED.test(m.text) && (m.toolResults ?? []).length === 0) {
            waiting = true
          } else if (m.role === 'assistant' && waiting && m.text.trim().length > 0) {
            keys.push(firstKey(m.text))
            waiting = false
          } else if (m.role === 'assistant' && waiting && m.toolUses.length > 0) {
            // The turn opened on tools: its first call's row carries the label.
            tools.push(m.toolUses[0]?.tool_use_id ?? '')
            waiting = false
          }
        }

        // Seeded openers carry no turn (history has none); one already recorded keeps its own.
        // One entry per turn, so a plain cut drops whole turns.
        await update($, firstTexts, list =>
          [...[...new Set(keys)].filter(k => !list.some(x => x.key === k)).map(k => ({ key: k })), ...list].slice(-FIRSTS_MAX)
        )
        await update($, firstTools, list => [...new Set([...tools.filter(t => t.length > 0), ...list])].slice(-FIRSTS_MAX))
      }
    } catch {
      // No history: live turns still mark their openers.
    }

    await startCockpit($, e)

    return next(e)
  })

  // Live: a typed prompt (or slash command) opens a turn; its first main-loop text row is the opener.
  on('session.append', async ($, e, next) => {
    // The engine's hot-reload note, `ghostframe: reloaded (13 hooks: ui.render, …)`, is kept
    // as one short line: `ghostframe reloaded · 13 hooks`. Any other row passes as it came.
    const shortened = reloadNote(e.message)

    if (shortened !== undefined) {
      return next({ ...e, message: shortened })
    }

    try {
      if (e.agentId === undefined && e.door === 'response') {
        await noteFlow($, e.message.content)
        await logSaid($, e.message.content)
      }

      if (e.agentId === undefined && (e.door === 'prompt' || e.door === 'command')) {
        await update($, awaitingFirst, () => true)
      } else if (e.agentId === undefined && e.door === 'response' && (await read($, awaitingFirst))) {
        // Claude's first visible block decides: prose text, or a tool call (the activity header).
        const opener = e.message.content.find(b => (b.type === 'text' && typeof b['text'] === 'string' && b['text'].trim().length > 0) || b.type === 'tool_use')

        const turn = await read($, currentTurn)

        if (opener?.type === 'text' && typeof opener['text'] === 'string') {
          const key = firstKey(opener['text'])
          await snapshotCaps($, key, turn, e.message.content, false)
          await update($, firstTexts, list => [...list, { key, turn }].slice(-FIRSTS_MAX))
          await update($, awaitingFirst, () => false)
        } else if (opener?.type === 'tool_use' && typeof opener['id'] === 'string') {
          const id = opener['id']
          await snapshotCaps($, id, turn, e.message.content, true)
          await update($, firstTools, list => [...list, id].slice(-FIRSTS_MAX))
          await update($, awaitingFirst, () => false)
        }
      }
    } catch {
      // Observing only: the row is stored as it was either way.
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  // The main loop's current turn, so each step knows which activity it joins.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, currentTurn, () => e.turnId)
      await update($, streaming, () => true)

      try {
        // A turn no prompt was typed for (a notice, a queued task) starts its clock at its first step.
        await logTurnStart($, e.turnId, unclaimedSubmit)
        unclaimedSubmit = undefined
      } catch {
        // A log that can't start costs the pane this turn's steps, nothing more.
      }
    }

    return next(e)
  })

  // Time every main-loop call. Observes only: the call runs exactly as it would.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const id = e.tool_use_id
    const now = async () => {
      try {
        return await $.clock.now()
      } catch {
        return undefined // a clock that fails costs the step its time; the step still settles
      }
    }
    const at = await now()

    try {
      const turn = await read($, currentTurn)
      await update($, steps, list => capTurns([...list, { id, turn, at: at ?? 0, ms: null, tool: e.tool }], STEPS_MAX, turn))
    } catch {
      // A stamp that fails costs the row its time, nothing more.
    }

    try {
      await logStepStart($, e, at ?? 0, cwd)
    } catch {
      // A pane row that fails costs the pane that row; the call runs as it would.
    }

    let ran: Awaited<ReturnType<typeof next>> | undefined

    try {
      ran = await next(e)

      try {
        await afterCall($, e, ran)
      } catch {
        // A card that can't be read costs the row its card; the activity output stays.
      }

      return ran
    } finally {
      // Always settled. A start or end the clock couldn't give: 0ms at the known end, so the
      // step never counts toward its turn's time; neither known: the step is dropped.
      const end = await now()
      const when = at ?? end
      const ms = at !== undefined && end !== undefined ? end - at : 0
      const ok = ran !== undefined && ran.isError !== true && ran.deny === undefined

      try {
        await update($, steps, list => (when === undefined ? list.filter(s => s.id !== id) : list.map(s => (s.id === id ? { ...s, at: when, ms, ok } : s))))

        if ((await read($, asked)).includes(id)) {
          await update($, asked, list => list.filter(x => x !== id))
        }
      } catch {
        // as above
      }

      try {
        await logStepEnd($, e, ran, end ?? when ?? 0)
      } catch {
        // as above
      }
    }
  }).catch((_$, e, next) => next(e))

  // Permission: note a main-loop call whose check asks the person, so its row can say it
  // waits on you. Observes only: the verdict is handed up exactly as heard.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    try {
      const id = e.tool_use_id

      if (e.agentId === undefined && id !== undefined && e.approver === 'person' && verdict.decision === 'ask') {
        await update($, asked, list => [...list.filter(x => x !== id), id].slice(-100))
        await logAsk($, id)
      }
    } catch {
      // A note that fails costs the row its `needs you`, nothing more.
    }

    return verdict
  }).catch((_$, e, next) => next(e)) // never decides: the verdict beneath stands

  // A standalone call's row. ctrl+o (expanded) stays the engine's; a tool we can't read is
  // the engine's row, in the gutter grid.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const lay = layout(e.viewport?.columns)
    const width = lay?.width
    // Only the paths that hand the row to the engine pay for the quieted output.
    const quiet = () => quietEvent(e)

    if (e.surface !== 'terminal' || e.props.isExpanded || lay === undefined || width === undefined) {
      return next(quiet())
    }

    const p = e.props
    const isAsking = (await read($, asked)).includes(p.tool_use_id)
    const browser = browserTool(p.tool)
    const step = stepOf(
      p.tool,
      p.input,
      p.output,
      { ...p, isAsking },
      cwd,
      browser === undefined ? undefined : { verb: browserVerb(browser, p.input), target: browserTarget(browser, p.input), isPath: false }
    )
    const list = await read($, steps)
    const opensTurn = (await read($, firstTools)).includes(p.tool_use_id)
    const blocks = await read($, flow)
    const place = flowPlace(blocks, f => f.kind === 'tool' && f.key === p.tool_use_id, await read($, streaming), await read($, currentTurn))
    const above = browserOpenAbove(blocks, place)
    const capsRow = opensTurn ? await openerCaps($, o => o.key === p.tool_use_id, width) : undefined
    const ui = $.ui.resolve(e)
    const head = activityHead(list, p.tool_use_id)
    const time = stepTime(list, p.tool_use_id)
    const fold = foldOf(list, p.tool_use_id, isBrowserTool)
    // §0.2: narration right above this row → one blank row between them.
    const gap = afterNarration(blocks, place)

    // A settled turn: its first folded step draws the one `◦ N earlier steps` row (with
    // the activity rule and `claude` it carried); the other folded steps draw nothing.
    if (fold !== undefined) {
      return fold.isAnchor ? inGrid(ui, head, lay, drawParts(ui, foldRow(fold, width), 'fold'), opensTurn, { close: above, caps: capsRow, gap }) : ui.Box({})
    }

    if (step === undefined) {
      return engineInGutter(ui, await next(quiet()), head, lay, opensTurn, { close: above, caps: capsRow, gap })
    }

    // A browser call whose place is known: one row of the session frame. The first of a
    // run draws the top edge; the block after the run draws the bottom (§5.14).
    if (browser !== undefined && place !== undefined) {
      const opens = above === 0
      const url = browserUrl(browser, p.input)
      const lines = [
        ...(opens ? [browserTop(width, browser.engine)] : []),
        ...(url !== undefined ? [urlBar(width, url, { t: step.dot.text, color: step.dot.color }, time)] : []),
        ...stepParts(step, time, width - 4).map(r => frameRow(width, r))
      ]

      return inGrid(ui, head, lay, drawRows(ui, lines, 'browser'), opensTurn, {
        caps: capsRow,
        gap: (opens && head === undefined && !opensTurn) || gap
      })
    }

    return inGrid(ui, head, lay, drawStep(ui, step, time, width, 'step'), opensTurn, { close: above, caps: capsRow, gap })
  })

  // A folded group of reads/searches: one timeline row per call (v3), when every call is
  // one we can read and the group holds nothing but calls. Expanded → the engine.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const lay = layout(e.viewport?.columns)
    const width = lay?.width

    if (e.surface !== 'terminal' || e.props.isExpanded || lay === undefined || width === undefined) {
      return next(e)
    }

    const asking = await read($, asked)
    const rows =
      e.props.isCallsOnly === true
        ? e.props.calls.map(c => stepOf(c.tool, c.input, c.output, { ...c, isAsking: c.tool_use_id !== undefined && asking.includes(c.tool_use_id) }, cwd))
        : []
    const list = await read($, steps)
    const first = e.props.calls[0]?.tool_use_id
    const opensTurn = first !== undefined && (await read($, firstTools)).includes(first)
    const blocks = await read($, flow)
    const place =
      first === undefined ? undefined : flowPlace(blocks, f => f.kind === 'tool' && f.key === first, await read($, streaming), await read($, currentTurn))
    const extra = {
      close: browserOpenAbove(blocks, place),
      caps: opensTurn ? await openerCaps($, o => o.key === first, width) : undefined,
      gap: afterNarration(blocks, place)
    }
    const ui = $.ui.resolve(e)
    const folds = e.props.calls.map(c => foldOf(list, c.tool_use_id, isBrowserTool))
    const readable = rows.length > 0 && rows.every(r => r !== undefined)

    // A settled turn reaches into this group: folded calls leave, the anchor draws the
    // fold row. A group we can't draw whole folds only when all of it folds.
    if (folds.some(f => f !== undefined) && (readable || folds.every(f => f !== undefined))) {
      const anchor = folds.find(f => f?.isAnchor === true)
      const kept = rows.flatMap((r, i) =>
        folds[i] !== undefined || r === undefined ? [] : [drawStep(ui, r, stepTime(list, e.props.calls[i]?.tool_use_id), width, `step-${i}`)]
      )

      if (anchor === undefined && kept.length === 0) {
        return ui.Box({})
      }

      return inGrid(
        ui,
        anchor === undefined ? undefined : activityHead(list, first),
        lay,
        [...(anchor === undefined ? [] : [drawParts(ui, foldRow(anchor, width), 'fold')]), ...kept],
        opensTurn && anchor !== undefined,
        extra
      )
    }

    // Anything we can't draw whole is the engine's line, kept whole: indented to the step
    // dots, under the activity rule and `claude` when it opens the turn.
    if (rows.length === 0 || rows.some(r => r === undefined)) {
      return engineInGutter(ui, await next(e), activityHead(list, first), lay, opensTurn, extra)
    }

    return inGrid(
      ui,
      activityHead(list, first),
      lay,
      rows.map((r, i) => (r === undefined ? null : drawStep(ui, r, stepTime(list, e.props.calls[i]?.tool_use_id), width, `step-${i}`))),
      opensTurn,
      extra
    )
  })

  // Under a standalone row: the diff card for a small new file, outcome cards, states;
  // nothing for the rest. A shell's output never shows here: the row's result says how
  // it went, and ctrl+o (expanded) is the engine's output, without its own notes.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const lay = layout(e.viewport?.columns)
    const width = lay?.width
    const { tool, output, isErrored } = e.props
    // Only the paths that hand the result to the engine pay for the quieted output.
    const quiet = () => quietEvent(e)

    if (e.surface !== 'terminal' || e.props.isExpanded || lay === undefined || width === undefined) {
      return next(quiet())
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    // The engine's own result block, indented under its row in the content column.
    const engine = async () => engineInGutter(ui, await next(quiet()), undefined, lay, false)

    // A step folded into its turn's settled row takes its result with it.
    if (foldOf(await read($, steps), e.props.tool_use_id, isBrowserTool) !== undefined) {
      return <Box />
    }

    if (!OWN_RESULT(tool)) {
      return engine()
    }

    // Outcome cards (§5.15, §5.16), read off the call when it ended; a failing run is an
    // errored call, so this comes before the error branch. Nothing read → the rows below.
    // Only a turn's last test run and last shipping call draw a card (the final
    // evidence); earlier ones are their step rows, which already say how they went.
    if (tool === 'Bash' || tool === 'PowerShell') {
      const id = e.props.tool_use_id
      const stepList = await read($, steps)
      const runs = await read($, testRuns)
      const shipList = await read($, ships)
      const shows = cardCalls(stepList, runs, shipList).has(id)
      const run = shows ? runs.find(r => r.id === id) : undefined
      const ship = shows && shipList.some(x => x.id === id) ? mergeShips(stepList, shipList, id) : undefined

      if (run === undefined && ship === undefined) framedCalls.delete(id)

      if (run !== undefined || ship !== undefined) {
        const ms = stepList.find(x => x.id === id)?.ms ?? null
        const cards = frozenCard(`${id}|${width}`, ms !== null, () => [
          ...(run !== undefined ? [testsFrame(width, run, previousRun(runs, id), ms)] : []),
          ...(ship !== undefined ? [shippedFrame(width, ship)] : [])
        ])

        remember(framedCalls, id, true, FRAMED_MAX)

        return inGrid(
          ui,
          undefined,
          lay,
          cards.map((l, i) => <Box key={`card${i}`}>{drawFrame(ui, l)}</Box>)
        )
      }
    }

    if (isErrored) {
      return <Box />
    }

    // Edits: the step row's `+a −r` is enough; ctrl+o (expanded, handled above) shows the
    // engine's full diff. The card shows only for a new file under 12 lines.
    if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write') {
      const isNew = typeof output === 'object' && output !== null && (output as { type?: unknown }).type === 'create'
      const diff = isNew ? diffRows(output) : undefined

      return diff !== undefined && diff.rows.length < 12 ? inGrid(ui, undefined, lay, drawDiff(ui, diff, width)) : <Box />
    }

    if (tool === 'Bash' || tool === 'PowerShell') {
      const o = isObject(output) ? output : undefined
      const special =
        o === undefined ||
        o['isImage'] === true ||
        o['backgroundTaskId'] !== undefined ||
        o['persistedOutputPath'] !== undefined ||
        o['rawOutputPath'] !== undefined ||
        o['structuredContent'] !== undefined

      if (special) {
        return engine()
      }

      return <Box />
    }

    // An approved plan: one dim line in the content column; ctrl+o (expanded, handled
    // above) is the engine's whole plan. Unreadable → the engine's block.
    if (tool === 'ExitPlanMode') {
      const line = planLine(width, output, p => relPath(p, cwd))

      return line === undefined ? engine() : inGrid(ui, undefined, lay, drawParts(ui, line, 'plan'))
    }

    // States (§5.10): the task list is framed; unreadable → the engine's.
    if (tool === 'TodoWrite') {
      const lines = tasksFrame(width, output)

      if (lines === undefined) return engine()

      remember(framedCalls, e.props.tool_use_id, true, FRAMED_MAX)

      return inGrid(ui, undefined, lay, drawFrame(ui, lines))
    }

    return <Box />
  })

  // Stamp each typed prompt with the clock, for its turn rule.
  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && e.command === undefined && e.text.trim().length > 0) {
      const at = await $.clock.now()
      await update($, prompts, list => [...list, { text: e.text, at }].slice(-100))
      lastSubmitted = at
      unclaimedSubmit = at
    }

    return next(e)
  }).catch((_$, e, next) => next(e)) // a stamp that fails never holds a prompt back

  // Keep the latest main-loop turn's output tokens, for the close rule.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      lastClosed = e.turnId

      try {
        // Every reader of `streaming` (each reply on screen) draws again: tables re-flow.
        await update($, streaming, () => false)

        const used = await read($, tally)
        const browser = openRunBefore(await read($, flow), Number.MAX_SAFE_INTEGER, e.turnId)

        await update($, closes, list =>
          [...list, { durationMs: e.durationMs, tokens: e.usage?.output_tokens ?? null, tally: tallyText(used), browser, turn: e.turnId }].slice(-500)
        )
      } finally {
        // The next turn starts counting afresh, whatever happened above.
        await update($, tally, () => NO_TALLY)
        await update($, caps, () => NO_CAPS)
        // A turn that ended before any reply (aborted, a local command) opens nothing later.
        await update($, awaitingFirst, () => false)

        try {
          await logTurnEnd($, e.durationMs, e.isAborted)
        } catch {
          // A step left running reads `running` until the next turn starts.
        }
      }
    }

    return next(e)
  })

  // Turn close: the grid rule, `+` at both ends, `3s · 412 tokens · 2 skills · 1 hook`
  // right (§0.1 r3, r13, §5.17). Each rule finds its own turn by duration; when two turns
  // ran too close to tell apart, the rule shows its duration alone. A browser frame left
  // open by the turn's last calls gets its bottom edge above the rule.
  // Which close each footer row shows, by the row's request: the footer has only a
  // duration to go on, and several turns of about the same length (the same prompt run
  // again, say) used to leave it no single match, so it dropped its tokens and tally.
  // A row keeps the close it claimed. A first draw takes the turn that just completed when
  // its duration fits (the row the engine draws as a turn ends), else the oldest unclaimed
  // close that fits (rows redrawn in transcript order after a reload). Written while drawing.
  const footerClaims = new Map<string, string>()
  const claimClose = (row: string, durationMs: number, list: readonly TurnClose[]) => {
    const fits = list.filter(c => Math.abs(c.durationMs - durationMs) <= SAME_TURN_MS)
    const held = footerClaims.get(row)
    const kept = held === undefined ? undefined : fits.find(c => c.turn === held)

    if (kept !== undefined) return kept

    // Every path claims: a row's one fit would otherwise be free for the next row to take.
    const taken = new Set([...footerClaims.entries()].filter(([r]) => r !== row).map(([, t]) => t))
    const free = fits.filter(c => c.turn !== undefined && !taken.has(c.turn))
    const pick = free.find(c => c.turn === lastClosed) ?? free[0]

    if (pick?.turn !== undefined) remember(footerClaims, row, pick.turn, CLAIMS_MAX)

    return pick
  }

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.waitingFor) {
      return next(e)
    }

    const took = fmtDuration(e.props.durationMs)

    if (took.length === 0) {
      return next(e)
    }

    const mine = claimClose(e.requestId, e.props.durationMs, await read($, closes))
    const tokens = mine?.tokens === null || mine?.tokens === undefined ? '' : fmtTokens(mine.tokens)
    const label = [took, tokens, mine?.tally ?? ''].filter(x => x.length > 0).join(G.sep)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const lay = layout(e.viewport?.columns)
    // §0.2: one blank row above the footer rule; its meta ends at the measure.
    const rule = <Box marginTop={1}>{Rule(ui, undefined, { text: label, color: C.muted }, ruleWidth(lay))}</Box>

    if (mine === undefined || mine.browser === 0 || lay === undefined) {
      return rule
    }

    return (
      <Box flexDirection="column">
        {closeRow(ui, lay, mine.browser)}
        {rule}
      </Box>
    )
  })

  // The spinner (§5.11): props only. The verb says what the turn does; the engine keeps
  // its own time, tokens and `esc` hint. A state's own message stands.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // Docked Cockpit: the live area is one `working` row (E.33).
    const live = e.surface === 'terminal' ? await drawLive($, e) : undefined

    if (live !== undefined) {
      return live
    }

    const word = spinnerWord(e.props.mode)

    if (e.surface !== 'terminal' || e.props.message !== null || word === undefined) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, word, suffix: '' } })
  })

  // Thinking time before each block (§5.11): timed off the stream, every chunk passed on
  // untouched. Main loop only; what it counts lands on the capability line.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    if (e.agentId !== undefined) {
      return yield* stream
    }

    let since: number | undefined

    try {
      await logMode($, 'request')
    } catch {
      // The head says `waiting` a little late, nothing more.
    }

    for await (const chunk of stream) {
      try {
        await logMode($, chunk.kind)
        if (chunk.kind === 'thinking' && since === undefined) {
          since = await $.clock.now()
        } else if (since !== undefined && chunk.kind !== 'thinking' && chunk.kind !== 'engine') {
          const ms = (await $.clock.now()) - since
          since = undefined
          await update($, caps, c => ({ ...c, thoughtMs: c.thoughtMs + ms }))
        }
      } catch {
        since = undefined
      }

      yield chunk
    }

    return await stream.result
  })

  // A skill loaded for the turn: on the capability line, and in the tally.
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)

    try {
      await update($, caps, c => withSkill(c, e.skill))
      await update($, tally, t => (t.skills.includes(skillName(e.skill)) ? t : { ...t, skills: [...t.skills, skillName(e.skill)] }))
    } catch {
      // observing only
    }

    return r
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)

    try {
      await noteHook($, 'UserPromptSubmit', r, undefined)
    } catch {
      // observing only
    }

    return r
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const r = await next(e)

    try {
      await noteHook($, 'PreToolUse', r, 'agentId' in e ? e['agentId'] : undefined)
    } catch {
      // observing only
    }

    return r
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)

    try {
      await noteHook($, 'PostToolUse', r, (e as { agent_id?: unknown }).agent_id)
    } catch {
      // observing only
    }

    return r
  })

  // Slash-command output: muted, behind a small › (errors keep the engine's red).
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.text.trim().length === 0) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text, Markdown } = ui
    const lay = layout(e.viewport?.columns)
    // One line of output → a notice in the content column: `/  /effort high · applies from next turn`.
    const notice = lay === undefined ? undefined : commandNotice(e.props.command, e.props.args, e.props.text, lay.width)

    if (notice !== undefined && lay !== undefined) {
      return <Box paddingLeft={lay.gutter}>{drawParts(ui, notice, 'notice')}</Box>
    }

    return (
      <Box>
        <Text color={C.muted}>{'› '}</Text>
        <Box flexShrink={1}>
          <Markdown text={e.props.text} dimColor />
        </Box>
      </Box>
    )
  })

  // Info notice under the logo: one line in the content column, `› text · /command`,
  // muted text and dim marks, clipped at the measure (§0.2). No measure → the old row.
  on('ui.render', { component: 'InfoNotice' }, ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const lay = layout(e.viewport?.columns)

    if (lay !== undefined) {
      const text = e.props.text.replace(/\s+/g, ' ').trim()
      const parts: Part[] = [{ t: '› ', color: C.dim }, { t: text, color: C.muted }, ...(e.props.command ? [{ t: ` · ${e.props.command}`, color: C.dim }] : [])]

      return <Box paddingLeft={lay.gutter}>{drawParts(ui, partsWidth(parts) <= lay.width ? parts : fitParts(parts, lay.width), 'info')}</Box>
    }

    return (
      <Box>
        <Text color={C.muted}>{'› '}</Text>
        <Box flexShrink={1}>
          <Text color={C.muted}>{e.props.command ? `${e.props.text} ${e.props.command}` : e.props.text}</Text>
        </Box>
      </Box>
    )
  })
}
