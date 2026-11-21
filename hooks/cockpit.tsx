// Cockpit: the pane beside the transcript. Phase 1, the seat: it opens at session start and docks at the
// width rule (hooks/seat.ts). Phase 2, the step log: the turn's `[ STEPS ]` (hooks/steplog.ts). Phase 3, the
// head: `[ NOW ]` / `[ LAST ]` above it, and the left's live area reduced to one row (hooks/head.ts).
// Spec: docs/design/cockpit-v7.md C.1, E.24, E.33, E.36 to E.39, H; docs/design/cockpit-v7-amendments.md.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, RenderInput, SessionStartInput, Timer, ToolCallInput, UiOpenResult } from 'claude-code'

import { liveRow, paneRows } from './head'
import { DOCK_MIN, paneColumns, terminalColumns } from './seat'
import { askStep, endTurn, newLog, newTurn, noteMode, noteSaid, settleStep, startStep } from './steplog'
import type { Outcome } from './steplog'
import type { Ui } from './grid'
import type { Part } from './states'

type On = Parameters<Register>[0]
type SessionStart = Pick<SessionStartInput, 'isInteractive' | 'surface'>

const PANE = 'cockpit'

// The current (or last) main-loop turn's log. Change the tag when its fields change.
const stepLog = atom({ plugin: 'ghostframe', key: 'stepLog' } as const, newLog(null, null), { shape: 'stepLog-2' })
// Counters the timers bump while a turn runs: each second (the pane's running clock) and each spinner frame.
const second = atom({ plugin: 'ghostframe', key: 'second' } as const, 0, { shape: 'second-1' })
const frame = atom({ plugin: 'ghostframe', key: 'frame' } as const, 0, { shape: 'frame-1' })

const SECOND_MS = 1_000
const FRAME_MS = 100 // H.1 asks 80 ms; the engine redraws a site at most ten times a second

// shortcut: the timers live in the module; a reload stops them (the engine's rule) and a turn running across a
// reload then shows its last second until the next turn starts. Fine while Cockpit is a test-only feature.
let timers: Timer[] = []

/**
 * A second passed: the pane, which reads `second`, draws again.
 * @param $ the engine interface
 */
async function tickSecond($: EngineInterface): Promise<void> {
  await update($, second, n => n + 1)
}

/**
 * A spinner frame passed: the live row, which reads `frame`, draws again.
 * @param $ the engine interface
 */
async function tickFrame($: EngineInterface): Promise<void> {
  await update($, frame, n => n + 1)
}

/** Stops the turn's timers. */
function stopTimers(): void {
  for (const timer of timers) timer.cancel()

  timers = []
}

/**
 * A main-loop turn starts: its log starts empty, on its own clock, and the timers start.
 * @param $ the engine interface
 * @param turn the turn's id
 * @param at when its prompt was submitted (wall clock, ms); undefined, its first step starts the clock
 */
export async function logTurnStart($: EngineInterface, turn: string, at: number | undefined): Promise<void> {
  if (!isOn()) return

  await update($, stepLog, log => newTurn(log, turn, at ?? null))
  lastMode = undefined
  stopTimers()
  timers = [$.clock.every(SECOND_MS, () => void tickSecond($)), $.clock.every(FRAME_MS, () => void tickFrame($))]
}

// The mode last written, so a stream of text chunks writes the log once, not once per chunk.
let lastMode: string | undefined
const CHUNK_MODE: Record<string, string> = { thinking: 'thinking', text: 'responding', input: 'tool-input', tool: 'tool-input' }

/**
 * What the main loop is doing changed (E.38 row 2 when no step runs): a model call started (`requesting`), or its
 * stream moved to thinking, text or a tool call. Written only on a change; a render may not write.
 * @param $ the engine interface
 * @param what `request`, or the stream chunk's kind
 */
export async function logMode($: EngineInterface, what: string): Promise<void> {
  const mode = what === 'request' ? 'requesting' : CHUNK_MODE[what]

  if (!isOn() || mode === undefined || mode === lastMode) return

  lastMode = mode
  const at = await $.clock.now()
  await update($, stepLog, log => (log.isTurnRunning ? noteMode(log, mode, at) : log))
}

/**
 * A main-loop call starts: its row appears.
 * @param $ the engine interface
 * @param e the call
 * @param at the wall clock in ms
 * @param cwd the session's folder, for relative paths
 */
export async function logStepStart($: EngineInterface, e: ToolCallInput, at: number, cwd: string | undefined): Promise<void> {
  if (!isOn()) return

  await update($, stepLog, log => startStep(log, { id: e.tool_use_id, tool: e.tool, input: e, at }, cwd))
}

/**
 * A main-loop call ends: its row settles.
 * @param $ the engine interface
 * @param e the call
 * @param outcome what `next(e)` resolved to; undefined when it threw
 * @param at the wall clock in ms
 */
export async function logStepEnd($: EngineInterface, e: ToolCallInput, outcome: Outcome | undefined, at: number): Promise<void> {
  if (!isOn()) return

  await update($, stepLog, log => settleStep(log, { id: e.tool_use_id, tool: e.tool, input: e, at, outcome: outcome ?? { isError: true, text: 'failed' } }))
  lastMode = 'requesting'
}

/**
 * A main-loop call waits on the person's permission answer: `[ NOW ]` says `needs you`.
 * @param $ the engine interface
 * @param id the call's id
 */
export async function logAsk($: EngineInterface, id: string): Promise<void> {
  if (!isOn()) return

  await update($, stepLog, log => askStep(log, id))
}

/**
 * Claude said something in the main loop: the last text block's first sentence is `[ NOW ]`'s row 1.
 * @param $ the engine interface
 * @param content the response's content blocks
 */
export async function logSaid($: EngineInterface, content: readonly { type: string; [k: string]: unknown }[]): Promise<void> {
  if (!isOn()) return

  const text = content.findLast(b => b.type === 'text' && typeof b['text'] === 'string' && b['text'].trim().length > 0)?.['text']

  if (typeof text === 'string') await update($, stepLog, log => noteSaid(log, text))
}

/**
 * A main-loop turn ends: a step still running was cut, the head turns to `[ LAST ]`, and the timers stop.
 * @param $ the engine interface
 * @param durationMs how long the turn ran
 * @param isAborted whether it was interrupted (correction G: no receipt; `[ LAST ]` carries the state)
 */
export async function logTurnEnd($: EngineInterface, durationMs: number, isAborted: boolean): Promise<void> {
  if (!isOn()) return

  stopTimers()
  await update($, stepLog, log => endTurn(log, durationMs, isAborted))
}

// The first open comes before any drawing has measured the terminal: ask for the hero width,
// and the first Pane render opens again at the width rule.
const FIRST_COLUMNS = 72

// shortcut: kept in the module, so a reload forgets them; the next Pane render then opens once more
// at the width rule, and an inline pane the person asked for before the reload is closed. Move them
// to $.state when the pane holds anything worth keeping across a reload.
/** The terminal's columns at Cockpit's last open, so it opens again only when the width changes (correction K). */
let openedAt: number | undefined
/** The terminal's columns where Cockpit last closed an inline pane, so a refused close cannot loop. */
let leftAt: number | undefined
/** The person's `/cockpit` ran where no dock exists, so an inline pane is theirs and stays. */
let isAskedInline = false
/** The pane is docked now: the left's live area is then one row (E.33); otherwise it is the engine's. */
let isDocked = false

// Cockpit is unfinished, so it is off unless asked for: the `cockpit` option (/config, `pluginConfigs`)
// or GHOSTFRAME_COCKPIT=1 for a test session. Off, it opens nothing and draws nothing.
/** The `cockpit` option, as `register` received it. */
let isOptionOn = false
/** GHOSTFRAME_COCKPIT, as read at session start. */
let isEnvOn = false
const OFF_NOTE = 'cockpit is off · enable with /config (Cockpit pane) or GHOSTFRAME_COCKPIT=1'

const isOn = () => isOptionOn || isEnvOn

/**
 * Whether GHOSTFRAME_COCKPIT turns Cockpit on. An environment the engine cannot read leaves it off:
 * this must never be what holds back the rest of `session.start`.
 * @param $ the engine interface
 * @returns true for `1`, `true`, `on` or `yes`
 */
async function isEnvSet($: EngineInterface): Promise<boolean> {
  try {
    return /^(1|true|on|yes)$/i.test((await $.env.get('GHOSTFRAME_COCKPIT')) ?? '')
  } catch {
    return false
  }
}

/**
 * Opens (or re-opens) the pane at the width rule for a terminal this wide.
 * @param $ the engine interface
 * @param columns the terminal's columns
 * @returns whether the engine placed it
 */
async function openAt($: EngineInterface, columns: number): Promise<UiOpenResult> {
  openedAt = columns

  return $.ui.open({ id: PANE, columns: paneColumns(columns) })
}

/**
 * Closes an inline pane nobody asked for. In fullscreen it then opens again on its own, which waits
 * undrawn until the terminal is wide enough for the dock again.
 * @param $ the engine interface
 * @param columns the terminal's columns
 * @param isFullscreen whether this session docks panes at all
 */
async function leaveInline($: EngineInterface, columns: number, isFullscreen: boolean): Promise<void> {
  leftAt = columns
  await $.ui.close({ id: PANE })

  if (isFullscreen) {
    await openAt($, columns)
  }
}

/**
 * Logs a seat change that failed; the pane keeps the seat it had.
 * @param $ the engine interface
 * @param error what the engine answered
 */
function logSeatError($: EngineInterface, error: unknown): void {
  $.ui.log(`cockpit: seat change failed: ${String(error)}`)
}

/**
 * Cockpit's part of `session.start` (a plugin hooks it once): registers `/cockpit` and opens the pane.
 * Unasked, the engine docks it from 144 columns (110 once asked) and holds it undrawn below that.
 * @param $ the engine interface
 * @param e the session start's input
 */
export async function startCockpit($: EngineInterface, e: SessionStart): Promise<void> {
  await $.command.register({ name: PANE, description: 'Open or close the Cockpit pane' })
  isEnvOn = await isEnvSet($)

  if (isOn() && e.isInteractive && e.surface === 'terminal') {
    void $.ui.open({ id: PANE, columns: FIRST_COLUMNS }).catch((error: unknown) => logSeatError($, error))
  }
}

/**
 * Rows as Text lines, one per row.
 * @param ui the surface's elements
 * @param rows the rows
 * @returns the lines
 */
function drawRows(ui: Pick<Ui, 'Text'>, rows: readonly (readonly Part[])[]) {
  const { Text } = ui

  return rows.map((row, i) => (
    <Text key={`row:${i}`} wrap="truncate">
      {row.map((p, j) => (
        <Text key={`${j}`} color={p.color} {...(p.bold === true ? { weight: 'bold' as const } : {})}>
          {p.t}
        </Text>
      ))}
    </Text>
  ))
}

/**
 * Cockpit's part of the `Spinner` site (a plugin hooks it once): while the pane is docked, the left's live area
 * is one row, `working` and the turn's time (E.33). Undefined leaves the site to the caller.
 * @param $ the engine interface
 * @param e the render
 * @returns the row's tree, or undefined
 */
export async function drawLive($: EngineInterface, e: RenderInput<'Spinner', 'terminal'>) {
  if (!isOn() || !isDocked || e.viewport === undefined) return undefined

  const now = await $.clock.now()
  const ui = $.ui.resolve(e)
  const { Box } = ui
  // The transcript's frame: its last column stays empty, and it never passes 120 (C.1).
  const width = Math.min(e.viewport.columns - 1, 120)

  return <Box>{drawRows(ui, [liveRow(await read($, stepLog), now, await read($, frame), width)])}</Box>
}

/**
 * Adds Cockpit's hooks: the `/cockpit` command and the pane's drawing.
 * @param on the `on` that `register` receives
 * @param options the plugin's options; `cockpit: true` turns Cockpit on
 */
export function registerCockpit(on: On, options: PluginOptions): void {
  isOptionOn = options['cockpit'] === true

  on('command.run', { command: PANE }, async ($, e) => {
    if (!isOn()) {
      return { text: OFF_NOTE }
    }

    const isPlaced = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)

    if (isPlaced) {
      await $.ui.close({ id: PANE })

      return { text: 'pane closed' }
    }

    const { columns, isFullscreen } = e.presentation
    isAskedInline = !isFullscreen || columns < DOCK_MIN
    leftAt = undefined
    const opened = await openAt($, columns)

    return { text: opened.isPlaced ? `pane open · ${paneColumns(columns)} columns` : `pane not placed · ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!isOn()) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    const { placement, bodyColumns, scroll } = e.props
    const viewport = e.viewport

    if (e.surface === 'terminal' && viewport !== undefined) {
      const columns = terminalColumns(placement, viewport.columns, bodyColumns)
      isDocked = placement !== 'inline'

      if (placement === 'inline') {
        if (!isAskedInline && leftAt !== columns) {
          void leaveInline($, columns, viewport.isFullscreen === true).catch((error: unknown) => logSeatError($, error))
        }

        if (!isAskedInline) {
          return <Box />
        }
      } else if (columns !== openedAt) {
        void openAt($, columns).catch((error: unknown) => logSeatError($, error))
      }
    }

    // The head, one blank row, then `[ STEPS ]`, fitted to the body so the engine never scrolls it (E.37).
    // Reading `second` redraws this each second while a turn runs; only the running step's clock changes.
    await read($, second)
    const log = await read($, stepLog)
    const rows = paneRows(log, log.isTurnRunning ? await $.clock.now() : 0, bodyColumns, scroll.bodyRows, e.props.isPromptCovered === true)

    return <Box flexDirection="column">{drawRows(ui, rows)}</Box>
  })
}
