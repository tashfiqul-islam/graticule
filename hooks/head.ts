// Cockpit's head (spec E.38, H.1 to H.3, amendment 2): `[ NOW ]` while a turn runs, `[ LAST ]` when it has
// ended, one blank row, then `[ STEPS ]`; and the left's one-row live area. Pure: hooks/cockpit.tsx draws it.
import type { LogStep, StepLog } from '../types'
import { fmtClock, vw } from './grid'
import type { Part } from './states'
import { cut, formatSpan, sectionLabel, stepRows } from './steplog'
import { C } from './tokens'

const KIND_W = 9 // the kind word's 8 cells and a space
const LEAD = 2 + KIND_W
const CLOCK_W = 7
const CLOCK_GAP = 2
const STEP_ROWS_MIN = 3 // below the head, one blank row and a label: fewer than this many step rows shows the head alone

/** The spinner's frames (H.1), one every 100 ms: the only animated cell on screen. */
export const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const spaces = (n: number) => ' '.repeat(Math.max(0, n))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Text padded to exactly `width` cells. */
function line(t: string, width: number, color: string): Part[] {
  const s = cut(t, width)

  return [{ t: s + spaces(width - vw(s)), color }]
}

/** `  kind     subject …   12s`: a kind word, a subject, a clock on the time edge; exactly `width` cells. */
function stepLine(kind: string, subject: string, clock: string, width: number, clockColor: string): Part[] {
  const room = width - LEAD - CLOCK_GAP - CLOCK_W
  const s = cut(subject, room)

  return [
    { t: `  ${kind.padEnd(KIND_W).slice(0, KIND_W)}`, color: C.muted },
    { t: s + spaces(room - vw(s)), color: C.textBright },
    { t: spaces(CLOCK_GAP) + spaces(CLOCK_W - vw(clock)) + clock, color: clockColor }
  ]
}

// A live clock: hidden for its first second (H.2), so a step that takes 0.3 s never flashes a `0.3s`.
const since = (now: number, at: number | null) => (at === null || now - at < 1_000 ? '' : formatSpan(now - at))

/**
 * What the turn waits on the person for, when the oldest running step asked. A permission check that a
 * classifier answers asks nobody: `permission` only while a dialog covers the prompt.
 */
function needsYou(log: StepLog, step: LogStep | undefined, isPromptCovered: boolean): string | undefined {
  if (step === undefined) return undefined
  if (log.asking.includes(step.id) && isPromptCovered) return 'permission'
  if (step.kind === 'ask') return 'question'
  if (step.kind === 'plan') return 'plan'

  return undefined
}

/** `[ NOW ]`: the label with the turn and the step, the sentence, and the step (or the moment) with its own clock. */
function nowRows(log: StepLog, now: number, width: number, isPromptCovered: boolean): Part[][] {
  const running = log.steps.filter(s => s.isRunning)
  const first = running[0]
  const total = log.steps.length + log.dropped
  const turn = `turn ${log.turnNo}`
  const meta = first !== undefined ? `${turn} · step ${log.dropped + log.steps.indexOf(first) + 1}` : total > 0 ? `${turn} · ${plural(total, 'step')}` : turn
  const asked = needsYou(log, first, isPromptCovered)
  const label = sectionLabel('NOW', [{ t: meta, color: C.muted }], width, asked === undefined ? C.muted : C.warn)
  const sentence = log.said.length > 0 ? log.said : total === 0 ? 'Waiting for the first token.' : 'Working.'
  const row1 = asked === undefined ? [{ t: '▸ ', color: C.textBright }, ...line(sentence, width - 2, C.text)] : line(`! needs you · ${asked}`, width, C.warn)

  if (first !== undefined && log.startedAt !== null) {
    const more = running.length > 1 ? ` +${running.length - 1}` : ''

    return [label, row1, stepLine(first.kind, first.subject + more, since(now, log.startedAt + first.clock), width, asked === undefined ? C.muted : C.warn)]
  }

  const moment: Record<string, [string, string]> = {
    thinking: ['thinking', ''],
    requesting: ['waiting', ''],
    responding: ['writing', 'the answer'],
    'tool-input': ['tool', 'preparing…'],
    'tool-use': ['tool', 'preparing…']
  }
  const [kind, subject] = moment[log.mode ?? 'requesting'] ?? ['waiting', '']

  return [label, row1, stepLine(kind, subject, since(now, log.modeSince), width, C.muted)]
}

const STATE_COLOR = { done: C.ok, failed: C.err, interrupted: C.warn } as const

/** `[ LAST ]`: the label with the turn and when it ended; the state word, the story, the time; what waits. */
function lastRows(log: StepLog, width: number): Part[][] {
  const last = log.last

  if (log.turnNo === 0 || last === null) {
    return [sectionLabel('LAST', [{ t: 'no turn yet', color: C.muted }], width), line('  nothing has run in this session', width, C.muted)]
  }

  const when = last.endedAt === null ? '' : ` · ${fmtClock(last.endedAt)}`
  const time = formatSpan(last.durationMs)
  const room = width - 2 - CLOCK_GAP - CLOCK_W
  const story = cut(`${last.state} · ${last.story}`, room).slice(last.state.length)

  return [
    sectionLabel('LAST', [{ t: `turn ${log.turnNo}${when}`, color: C.muted }], width),
    [
      { t: `  ${last.state}`, color: STATE_COLOR[last.state] },
      { t: story + spaces(room - vw(last.state) - vw(story)), color: C.text },
      { t: spaces(CLOCK_GAP) + spaces(CLOCK_W - vw(time)) + time, color: C.muted }
    ],
    ...(last.wait.length > 0 ? [line(`  ${last.wait}`, width, C.muted)] : [])
  ]
}

/**
 * The whole pane, fitted to `rows` (E.37 with amendment 2): the head, one blank row, then `[ STEPS ]` for this
 * turn, or for the last turn that had steps while this one has none. Too short for three step rows: the head alone.
 * @param log the turn's log
 * @param now the wall clock in ms, for the running step's own clock
 * @param width the pane's body columns
 * @param rows the pane's body rows
 * @param isPromptCovered a dialog covers the prompt (the `Pane` prop): a permission answer is awaited
 * @returns one Part list per row
 */
export function paneRows(log: StepLog, now: number, width: number, rows: number, isPromptCovered = false): Part[][] {
  const head = log.isTurnRunning ? nowRows(log, now, width, isPromptCovered) : lastRows(log, width)
  const own = log.steps.length > 0 || log.dropped > 0
  const shown = own ? log : log.prev === null ? undefined : { ...log, steps: log.prev.steps, dropped: log.prev.dropped }
  const room = rows - head.length - 1

  if (shown === undefined || room < 1 + STEP_ROWS_MIN) return head

  return [...head, line('', width, C.muted), ...stepRows(shown, width, room, own ? 'STEPS' : `STEPS · TURN ${log.prev?.turnNo ?? 0}`)]
}

/**
 * The left's live area while docked (E.33, H.1): one row, the spinner frame, `working` (or `writing` while the
 * answer streams), and the turn's elapsed time on the time edge.
 * @param log the turn's log
 * @param now the wall clock in ms
 * @param frame the spinner's frame count
 * @param width the transcript frame's width
 * @returns exactly `width` cells
 */
export function liveRow(log: StepLog, now: number, frame: number, width: number): Part[] {
  const word = log.mode === 'responding' ? 'writing' : 'working'
  const time = since(now, log.startedAt)
  const glyph = FRAMES[frame % FRAMES.length] ?? FRAMES[0] ?? ''

  return [
    { t: glyph, color: C.accent },
    { t: ` ${word}`, color: C.text },
    { t: spaces(width - 1 - vw(` ${word}`) - vw(time)) + time, color: C.muted }
  ]
}
