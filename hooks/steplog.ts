// Cockpit's step log: one turn's tool calls as `[ STEPS ]` rows (spec E.12, E.37, E.39, H.5; amendments 1
// and 2). Pure: hooks/cockpit.tsx keeps the log in $.state and draws what `stepRows` returns.
import type { LastTurn, StepLog, LogStep, StepMark } from '../types'
import { DENIED, describe, firstErrorLine, mcpName, relPath, resultOf, TEST_CMD } from './activity'
import { cellWidth, vw } from './grid'
import { isShipCommand, parseShip, runnerOf, shellText } from './outcome'
import type { Part } from './states'
import { parseTests } from './testsummary'
import { C } from './tokens'

export type { LogStep, StepLog } from '../types'

/** A call as it starts: its id, tool, input, and the wall clock in ms. */
export type StepStart = { id: string; tool: string; input: unknown; at: number }

/** What the call came back with, as `tool.call`'s `next(e)` resolves (a deny, an error, or the tool's record). */
export type Outcome = { result?: unknown; text?: string | undefined; isError?: true | undefined; deny?: string | undefined }

/** A call as it ends. */
export type StepEnd = StepStart & { outcome: Outcome }

// shortcut: one turn is held whole; past this many steps the oldest are dropped and counted in `dropped`.
// Move the log to $.store when history lands (phase 8).
const STEPS_MAX = 5_000

const KIND_W = 9 // the kind word's 8 cells and a space
const LEAD = 2 + KIND_W // spine, gutter, kind: the subject starts here
const CLOCK_W = 7 // `59m 59s`
const CLOCK_GAP = 2
const INTERRUPTED = /\binterrupted\b/i

/** An empty log for a turn that started at `startedAt`; unknown (null), the turn's first step starts its clock. */
export function newLog(turn: string | null, startedAt: number | null): StepLog {
  return { turn, startedAt, steps: [], dropped: 0, turnNo: 0, isTurnRunning: false, said: '', mode: null, modeSince: null, asking: [], last: null, prev: null }
}

/**
 * A main-loop turn starts: the next number, an empty log, and the last turn that had steps kept for
 * `[ STEPS · TURN n ]` until this one has its own.
 */
export function newTurn(log: StepLog, turn: string, startedAt: number | null): StepLog {
  const prev = log.steps.length > 0 ? { turnNo: log.turnNo, steps: log.steps, dropped: log.dropped } : log.prev

  return { ...newLog(turn, startedAt), turnNo: log.turnNo + 1, isTurnRunning: true, prev }
}

/** Claude said something in this turn: its first sentence is `[ NOW ]`'s row 1. */
export function noteSaid(log: StepLog, text: string): StepLog {
  const line =
    text
      .split('\n')
      .find(l => l.trim().length > 0)
      ?.trim() ?? ''
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line

  return sentence.length === 0 ? log : { ...log, said: sentence }
}

/** The spinner's mode changed (`thinking`, `requesting`, …): kept with when it began, for `[ NOW ]`'s row 2. */
export function noteMode(log: StepLog, mode: string, at: number): StepLog {
  return log.mode === mode ? log : { ...log, mode, modeSince: at }
}

/** A step waits on the person's permission answer. */
export function askStep(log: StepLog, id: string): StepLog {
  return log.asking.includes(id) ? log : { ...log, asking: [...log.asking, id] }
}

const two = (n: number) => String(n).padStart(2, '0')

/**
 * One duration, as spec H.5 writes it everywhere: `0.4s`, `12s`, `4m 03s`, `1h 12m`, `1d 02h`.
 * @param ms the duration
 * @returns the string, at most 7 cells
 */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`

  const s = Math.floor(ms / 1_000)

  if (s < 60) return `${s}s`
  if (s < 3_600) return `${Math.floor(s / 60)}m ${two(s % 60)}s`
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ${two(Math.floor((s % 3_600) / 60))}m`

  return `${Math.floor(s / 86_400)}d ${two(Math.floor((s % 86_400) / 3_600))}h`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined)
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)
const firstLine = (t: string) =>
  t
    .split('\n')
    .find(l => l.trim().length > 0)
    ?.trim() ?? ''
const lastLine = (t: string) =>
  t
    .split('\n')
    .findLast(l => l.trim().length > 0)
    ?.trim() ?? ''
const isShell = (tool: string) => tool === 'Bash' || tool === 'PowerShell'
const command = (input: unknown) => firstLine(str(rec(input)['command']) ?? '')

/** The E.12 kind word for a call. */
function kindOf(tool: string, input: unknown): string {
  if (isShell(tool)) return TEST_CMD.test(command(input)) ? 'test' : 'shell'

  const mcp = mcpName(tool)

  if (mcp !== undefined) return /playwright|browser/i.test(mcp[0]) || mcp[1].startsWith('browser_') ? 'browser' : 'mcp'

  switch (tool) {
    case 'Glob':
    case 'Grep':
    case 'LSP':
      return 'search'
    case 'WebSearch':
      return 'web'
    case 'WebFetch':
      return 'fetch'
    case 'NotebookEdit':
      return 'notebook'
    case 'Agent':
    case 'Task':
      return 'agent'
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TodoWrite':
      return 'todo'
    default:
      return describe(tool, input)?.verb ?? tool.toLowerCase().slice(0, KIND_W - 1)
  }
}

/** The E.12 subject for a call. */
function subjectOf(tool: string, input: unknown, cwd: string | undefined): string {
  const i = rec(input)

  if (isShell(tool)) return command(input)

  switch (tool) {
    case 'Read': {
      const path = relPath(str(i['file_path']) ?? '', cwd)
      const from = int(i['offset'])
      const count = int(i['limit'])

      return from === undefined ? path : count === undefined ? `${path}:${from}` : `${path}:${from}-${from + count - 1}`
    }
    case 'WebSearch':
      return `"${str(i['query']) ?? ''}"`
    case 'WebFetch': {
      const url = str(i['url']) ?? ''

      try {
        const u = new URL(url)

        return `${u.host}${u.pathname.replace(/\/$/, '')}`
      } catch {
        return url
      }
    }
    case 'AskUserQuestion':
      return str(rec(Array.isArray(i['questions']) ? i['questions'][0] : undefined)['header']) ?? describe(tool, input)?.target ?? ''
    default: {
      const mcp = mcpName(tool)

      if (mcp !== undefined && kindOf(tool, input) === 'browser') {
        return [mcp[1].replace(/^browser_/, ''), str(i['element']) ?? str(i['url']) ?? ''].filter(x => x.length > 0).join(' ')
      }

      return describe(tool, input, cwd)?.target ?? ''
    }
  }
}

/** What a later step must share to fix a failed one: its kind and subject, and for a test run, its runner. */
function fixKey(kind: string, subject: string, input: unknown): string {
  return kind === 'test' ? `test:${runnerOf(command(input)) ?? subject}` : `${kind}:${subject}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// A check that passes by printing nothing (formatters, linters, type checkers): its silence reads `clean`.
const CHECK_CMD =
  /(?:^|[\s/])(?:oxlint|eslint|biome|prettier|oxfmt|ruff|black|gofmt|rustfmt|clippy|tsc|mypy|shellcheck|actionlint|zizmor|lint|fmt|format|typecheck)\b/
// `git` and its global options (`-C dir`, `-c k=v`, `--no-pager`) before the subcommand.
const gitSub = (sub: string) => new RegExp(String.raw`^git(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+${sub}\b`)
const GIT_STATUS = gitSub('status')
const GIT_DIFF = gitSub('diff')

/** `git status`, long or short: `clean`, `N changed`, `N untracked`, or both. */
function gitStatus(text: string): string {
  const lines = text.split('\n')
  const short = lines.filter(l => /^[ MADRCU?!]{2} \S/.test(l))
  let changed = short.filter(l => !l.startsWith('??')).length
  let untracked = short.length - changed

  if (short.length === 0) {
    const at = lines.findIndex(l => l.startsWith('Untracked files:'))
    const listed = (from: number, to: number) => lines.slice(from, to).filter(l => l.startsWith('\t')).length

    changed = listed(0, at < 0 ? lines.length : at)
    untracked = at < 0 ? 0 : listed(at, lines.length)
  }

  // Both at once must fit the 16-cell result: untracked files are new files.
  if (changed > 0 && untracked > 0) return `${changed} changed +${untracked} new`
  if (changed > 0) return `${changed} changed`

  return untracked > 0 ? `${untracked} untracked` : 'clean'
}

/** `git diff`: `+a −d` from a `--stat` summary or the patch; `no changes` when empty. */
function gitDiff(text: string): string {
  const added = /(\d+) insertions?\(\+\)/.exec(text)?.[1]
  const removed = /(\d+) deletions?\(-\)/.exec(text)?.[1]
  const isStat = added !== undefined || removed !== undefined
  const lines = text.split('\n')
  const adds = isStat ? Number(added ?? 0) : lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
  const dels = isStat ? Number(removed ?? 0) : lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length

  return adds + dels === 0 ? 'no changes' : [...(adds > 0 ? [`+${adds}`] : []), ...(dels > 0 ? [`−${dels}`] : [])].join(' ')
}

/** `ls`: `N items` (not `total n`, `.` or `..`), or `empty`. */
function listing(text: string): string {
  const items = text.split('\n').filter(l => l.trim().length > 0 && !/^total \d+$/.test(l.trim()) && !/(?:^|\s)\.\.?$/.test(l.trim()))

  return items.length === 0 ? 'empty' : plural(items.length, 'item')
}

/** A passing shell step's result: a short summary for common commands, else its last line of output. */
function shellSummary(cmd: string, text: string): string {
  if (GIT_STATUS.test(cmd)) return gitStatus(text)
  if (GIT_DIFF.test(cmd)) return gitDiff(text)
  if (/^ls\b/.test(cmd)) return listing(text)

  return lastLine(text) || (CHECK_CMD.test(cmd) ? 'clean' : 'no output')
}

const tonesText = (tones: readonly { text: string }[] | undefined) => tones?.map(t => t.text).join(' ') ?? ''

/** An error's result and mark. */
function failure(kind: string, tool: string, outcome: Outcome): { result: string; mark: StepMark } {
  const said = outcome.deny ?? outcome.text ?? ''

  if (INTERRUPTED.test(said)) return { result: 'interrupted', mark: '' }
  if (outcome.deny !== undefined || DENIED.test(said)) return { result: 'denied', mark: '' }

  if (kind === 'test') {
    const c = parseTests(said)

    if (c !== undefined && c.failed > 0) return { result: `${c.failed} of ${c.passed + c.failed} fail`, mark: '✕' }
  }

  if (isShell(tool)) {
    const code = /exit code[:\s]+(\d+)/i.exec(said)?.[1]

    return { result: code === undefined ? 'failed' : `exit ${code}`, mark: '✕' }
  }

  if (kind === 'read' && /does not exist|not found|no such file/i.test(said)) return { result: 'not found', mark: '✕' }
  if (kind === 'edit' && /not found|no match/i.test(said)) return { result: 'no match', mark: '✕' }
  if (/timed? ?out/i.test(said)) return { result: 'timed out', mark: '✕' }

  return { result: firstErrorLine(said) || 'failed', mark: '✕' }
}

/** A finished call's result and mark; `fixes` says a failed step with the same key is still open. */
function outcomeOf(kind: string, tool: string, input: unknown, outcome: Outcome, fixes: boolean): { result: string; mark: StepMark } {
  if (outcome.isError === true || outcome.deny !== undefined) return failure(kind, tool, outcome)

  const out = outcome.result

  if (kind === 'test') {
    const c = parseTests(shellText(out))

    if (c !== undefined)
      return c.failed > 0 ? { result: `${c.failed} of ${c.passed + c.failed} fail`, mark: '✕' } : { result: `${c.passed} pass`, mark: fixes ? '✓' : '' }
  }

  if (isShell(tool)) {
    const cmd = command(input)
    const ship = isShipCommand(cmd) ? parseShip('', cmd, shellText(out)) : undefined

    if (ship?.pr !== undefined) return { result: `PR #${ship.pr.n}`, mark: '↗' }
    if (ship?.push !== undefined) return { result: ship.push.to, mark: '↗' }
    if (ship?.commit !== undefined) return { result: ship.commit.sha, mark: '±' }

    return { result: shellSummary(cmd, shellText(out)), mark: fixes ? '✓' : '' }
  }

  switch (tool) {
    case 'WebFetch': {
      const r = rec(out)
      const code = int(r['code'])
      const bytes = int(r['bytes'])
      const size = bytes === undefined ? '' : ` · ${Math.max(1, Math.round(bytes / 1_000))} kB`

      return code === undefined ? { result: '', mark: '' } : { result: `${code}${size}`, mark: code >= 400 ? '✕' : '' }
    }
    case 'Skill':
      return { result: 'loaded', mark: '' }
    case 'TodoWrite': {
      const listed: unknown = rec(input)['todos']
      const todos: readonly unknown[] = Array.isArray(listed) ? listed : []

      return { result: `${todos.filter(t => rec(t)['status'] === 'completed').length} of ${todos.length}`, mark: '' }
    }
    case 'AskUserQuestion':
      return { result: tonesText(resultOf(tool, out)).replace(/^❯ /, ''), mark: '' }
    default: {
      const said = tonesText(resultOf(tool, out))

      return { result: said || (mcpName(tool) === undefined ? '' : firstLine(outcome.text ?? '')), mark: '' }
    }
  }
}

/** Whether a failed step is still open: no later step with its key settled without failing. */
function isOpen(steps: readonly LogStep[], index: number): boolean {
  const s = steps[index]

  return s !== undefined && s.mark === '✕' && !steps.slice(index + 1).some(t => !t.isRunning && t.key === s.key && t.mark !== '✕')
}

const clockOf = (log: StepLog, at: number) => Math.max(0, at - (log.startedAt ?? at))

/**
 * A call starts: its row appears last, in progress. An agent call joins the launch still running
 * in this turn, so a parallel launch is one row (amendment 1).
 */
export function startStep(started: StepLog, call: StepStart, cwd?: string): StepLog {
  const log = started.startedAt === null ? { ...started, startedAt: call.at } : started
  const kind = kindOf(call.tool, call.input)

  if (kind === 'agent') {
    const at = log.steps.findLastIndex(s => s.kind === 'agent' && s.isRunning)
    const launch = log.steps[at]

    if (launch !== undefined) {
      const calls = [...(launch.calls ?? []), call.id]
      const joined: LogStep = { ...launch, calls, subject: `${calls.length} launched` }

      return { ...log, steps: log.steps.with(at, joined) }
    }

    const row: LogStep = {
      id: call.id,
      kind,
      subject: '1 launched',
      key: `agent:${call.id}`,
      result: '',
      mark: '',
      isRunning: true,
      clock: clockOf(log, call.at),
      calls: [call.id],
      done: 0,
      failed: 0
    }

    return push(log, row)
  }

  const subject = subjectOf(call.tool, call.input, cwd)
  const row: LogStep = {
    id: call.id,
    kind,
    subject,
    key: fixKey(kind, subject, call.input),
    result: '',
    mark: '',
    isRunning: true,
    clock: clockOf(log, call.at)
  }

  return push(log, row)
}

function push(log: StepLog, row: LogStep): StepLog {
  const steps = [...log.steps, row]
  const over = Math.max(0, steps.length - STEPS_MAX)

  return { ...log, steps: steps.slice(over), dropped: log.dropped + over }
}

/** A call ends: its row settles, once. A launch settles when its last agent returns. */
export function settleStep(log: StepLog, end: StepEnd): StepLog {
  const at = log.steps.findIndex(s => s.isRunning && (s.id === end.id || s.calls?.includes(end.id) === true))
  const row = log.steps[at]

  if (row === undefined) return log

  const clock = clockOf(log, end.at)

  if (row.kind === 'agent') {
    const failedNow = end.outcome.isError === true || end.outcome.deny !== undefined
    const done = (row.done ?? 0) + (failedNow ? 0 : 1)
    const failed = (row.failed ?? 0) + (failedNow ? 1 : 0)
    const isRunning = done + failed < (row.calls?.length ?? 1)
    const result = isRunning ? '' : [`${done} done`, ...(failed > 0 ? [`${failed} failed`] : [])].join(' · ')

    return { ...log, steps: log.steps.with(at, { ...row, done, failed, isRunning, result, clock: isRunning ? row.clock : clock }) }
  }

  const fixes = log.steps.some((s, i) => i < at && s.key === row.key && isOpen(log.steps, i))
  const { result, mark } = outcomeOf(row.kind, end.tool, end.input, end.outcome, fixes)
  const asking = log.asking.filter(id => id !== end.id)

  // The step is answered; the model is called again: `[ NOW ]` says `waiting` from here.
  return { ...log, asking, mode: 'requesting', modeSince: end.at, steps: log.steps.with(at, { ...row, result, mark, isRunning: false, clock }) }
}

/** `[ LAST ]`'s verdict: the state word, the story in a few words, and what waits. */
function verdict(steps: readonly LogStep[], isAborted: boolean): Pick<LastTurn, 'state' | 'story' | 'wait'> {
  if (isAborted) {
    const cutAt = steps.findLast(s => s.result === 'interrupted')

    return { state: 'interrupted', story: cutAt === undefined ? plural(steps.length, 'step') : `cut at ${cutAt.kind} ${cutAt.subject}`, wait: '' }
  }

  if (steps.length === 0) return { state: 'done', story: 'no steps', wait: '' }

  const failures = steps.filter(s => s.mark === '✕')
  const open = failures.filter(s => isOpen(steps, steps.indexOf(s)))
  const first = open[0]

  if (first !== undefined) {
    return { state: 'failed', story: `${plural(open.length, 'failure')} · ${first.kind} ${first.subject}`, wait: 'ask Claude to continue' }
  }

  const shipped = steps.findLast(s => s.mark === '↗')
  const committed = steps.findLast(s => s.mark === '±')
  const facts = [
    ...(failures.length > 0 ? [`${plural(failures.length, 'failure')} → fixed`] : []),
    ...(committed === undefined ? [] : [`± ${committed.result}`]),
    ...(shipped === undefined ? [] : [`↗ ${shipped.result}`])
  ]

  return { state: 'done', story: facts.length > 0 ? facts.join(' · ') : plural(steps.length, 'step'), wait: '' }
}

/**
 * The turn ended after `durationMs`: a step still running was cut (an interrupted turn has no receipt; correction G),
 * its clock the turn's end, or where it started when the turn's start is unknown. The head turns to `[ LAST ]`.
 */
export function endTurn(log: StepLog, durationMs: number, isAborted = false): StepLog {
  const turnEnd = log.startedAt === null ? undefined : durationMs
  const steps = log.steps.map(s => (s.isRunning ? { ...s, isRunning: false, result: 'interrupted', mark: '' as const, clock: turnEnd ?? s.clock } : s))
  const last: LastTurn = { ...verdict(steps, isAborted), durationMs, endedAt: log.startedAt === null ? null : log.startedAt + durationMs }

  return { ...log, steps, isTurnRunning: false, asking: [], mode: null, modeSince: null, last }
}

/** A hard cut to `n` cells, ending in `…`; spec mocks cut mid-word (`bun te…`). */
export function cut(s: string, n: number): string {
  if (n <= 0) return ''
  if (vw(s) <= n) return s

  let out = ''
  let w = 0

  // A string iterates by code point, as grid.ts measures width.
  for (const ch of s) {
    const cw = cellWidth(ch)

    if (w + cw > n - 1) break

    out += ch
    w += cw
  }

  return `${out}…`
}

const spaces = (n: number) => ' '.repeat(Math.max(0, n))
const right = (s: string, n: number) => spaces(n - vw(s)) + s

const MARK_COLOR: Record<StepMark | '▸', string> = { '': C.muted, '✕': C.err, '✓': C.ok, '±': C.textBright, '↗': C.textBright, '▸': C.textBright }

/** One step row, exactly `width` cells. */
function stepRow(s: LogStep, width: number): Part[] {
  const mark = s.isRunning ? '▸' : s.mark
  const showClock = width >= 40
  const showResult = width >= 56 || (width >= 40 && mark !== '')
  // A launch result (`6 done · 1 failed`, amendment 1) may pass the 16-cell result cap by a cell or two.
  const resultMax = (width >= 72 ? 16 : 14) + (s.kind === 'agent' ? 2 : 0)
  const result = showResult ? cut(s.isRunning ? 'running' : s.result, resultMax) : ''
  const tail = showClock ? CLOCK_GAP + CLOCK_W : 0
  const room = width - LEAD - tail - (result.length > 0 ? vw(result) + 1 : 0)
  const subject = cut(s.subject, room)
  const resultColor = s.isRunning ? C.muted : s.mark === '✕' ? C.err : s.mark === '✓' ? C.ok : s.mark === '' ? C.muted : C.text

  return [
    { t: mark === '' ? ' ' : mark, color: MARK_COLOR[mark] },
    { t: ' ', color: C.muted },
    { t: s.kind.padEnd(KIND_W).slice(0, KIND_W), color: C.muted },
    { t: subject + spaces(room - vw(subject)), color: s.isRunning ? C.textBright : C.text },
    ...(result.length > 0 ? [{ t: ` ${result}`, color: resultColor, ...(s.mark === '✕' ? { bold: true } : {}) }] : []),
    ...(showClock ? [{ t: spaces(CLOCK_GAP) + right(formatSpan(s.clock), CLOCK_W), color: s.isRunning ? C.muted : C.dim }] : [])
  ]
}

/** `… n earlier · 20 shell · 14 read · 5 edit +3`: the hidden rows, counted exactly. */
function earlierRow(hidden: readonly LogStep[], dropped: number, width: number): Part[] {
  const counts = new Map<string, number>()

  for (const s of hidden) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1)

  const top = [...counts].toSorted((a, b) => b[1] - a[1]).slice(0, 3)
  const rest = hidden.length - top.reduce((n, [, c]) => n + c, 0) + dropped
  const words = [`… ${hidden.length + dropped} earlier`, ...top.map(([k, c]) => `${c} ${k}`)].join(' · ') + (rest > 0 ? ` +${rest}` : '')
  const t = `  ${cut(words, width - 2)}`

  return [{ t: t + spaces(width - vw(t)), color: C.dim }]
}

/**
 * A section's label rule, `┄ [ TITLE ] ┄…┄ meta`, exactly `width` cells: the title muted (or in `color`), the
 * meta parts at the right edge.
 */
export function sectionLabel(title: string, meta: readonly Part[], width: number, color: string = C.muted): Part[] {
  const used = vw(`┄ [ ${title} ] `) + 1 + meta.reduce((n, p) => n + vw(p.t), 0)

  return [
    { t: '┄ ', color: C.hairline },
    { t: '[ ', color: C.dim },
    { t: title, color },
    { t: ' ] ', color: C.dim },
    { t: '┄'.repeat(Math.max(1, width - used)), color: C.hairline },
    { t: ' ', color: C.muted },
    ...meta
  ]
}

/** `┄ [ STEPS ] ┄…┄ 12 steps · 2 failed`, exactly `width` cells. */
function labelRow(log: StepLog, width: number, title: string): Part[] {
  const total = log.steps.length + log.dropped
  const failed = log.steps.filter(s => s.mark === '✕').length
  const fail = failed > 0 ? [{ t: ` · ${failed} failed`, color: C.err }] : []

  return sectionLabel(title, [{ t: plural(total, 'step'), color: C.muted }, ...fail], width)
}

const OPEN_MAX = 3

/**
 * `[ STEPS ]` fitted to `rows` (E.37, alone in the pane): the label, then every step if they fit; else
 * `… n earlier`, the open failures (at most 3, else one `✕ n open` row), then the newest steps.
 * @param log the turn's log
 * @param width the pane's body columns
 * @param rows the pane's body rows
 * @param title the label: `STEPS`, or `STEPS · TURN n` for an earlier turn's steps
 * @returns one Part list per row, none when the turn has no steps
 */
export function stepRows(log: StepLog, width: number, rows: number, title = 'STEPS'): Part[][] {
  const steps = log.steps

  if (steps.length === 0 || rows < 1) return []

  const label = labelRow(log, width, title)
  const room = rows - 1

  if (steps.length <= room && log.dropped === 0) return [label, ...steps.map(s => stepRow(s, width))]
  if (room < 1) return [label]

  const open = steps.flatMap((_, i) => (isOpen(steps, i) ? [i] : []))
  let tail = Math.max(0, room - 1)
  let pinned: number[] = []

  // Pinned failures are the open ones above the window; the window grows as fewer are pinned.
  for (let pass = 0; pass < 4; pass++) {
    const first = steps.length - tail
    pinned = open.filter(i => i < first)
    const pinRows = pinned.length === 0 ? 0 : pinned.length <= OPEN_MAX ? pinned.length : 1
    tail = Math.max(0, room - 1 - pinRows)
  }

  const first = steps.length - tail
  const pinRows: Part[][] =
    pinned.length <= OPEN_MAX
      ? pinned.flatMap(i => {
          const s = steps[i]

          return s === undefined ? [] : [stepRow(s, width)]
        })
      : [[{ t: cut(`✕ ${pinned.length} open · s shows all`, width).padEnd(width), color: C.err }]]
  const shownPinned = new Set(pinned.length <= OPEN_MAX ? pinned : [])
  const hidden = steps.filter((_, i) => i < first && !shownPinned.has(i))

  return [label, earlierRow(hidden, log.dropped, width), ...pinRows, ...steps.slice(first).map(s => stepRow(s, width))]
}
