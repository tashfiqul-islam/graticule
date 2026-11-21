import { expect, test } from 'claude-code/testing'

import { paneRows } from '../hooks/head'
import { askStep, endTurn, newLog, newTurn, noteMode, noteSaid, settleStep, startStep } from '../hooks/steplog'
import type { Outcome, StepLog } from '../hooks/steplog'

const W = 72
const T0 = new Date(2026, 10, 21, 10, 26, 45).getTime() // the prompt's submit time (local); the turn clock starts here
const text = (log: StepLog, now: number, rows = 30) => paneRows(log, now, W, rows).map(row => row.map(p => p.t).join(''))
const ok = (result: unknown): Outcome => ({ result, text: '' })
const failed = (said: string): Outcome => ({ isError: true, text: said })

function step(log: StepLog, id: string, tool: string, input: Record<string, unknown>, outcome: Outcome, at: number, ms = 1_000): StepLog {
  return settleStep(startStep(log, { id, tool, input, at: T0 + at }), { id, tool, input, outcome, at: T0 + at + ms })
}

const turnOne = () => newTurn(newLog(null, null), 't1', T0)

test('[ NOW ] while a step runs: the sentence, the step, its own clock; one blank row, then [ STEPS ]', () => {
  let log = turnOne()
  log = step(log, 'a', 'Read', { file_path: 'a.ts' }, ok({ file: { numLines: 3 } }), 0)
  log = noteSaid(log, 'Running the width tests now. Then the fix.')
  log = startStep(log, { id: 'b', tool: 'Bash', input: { command: 'bun test width' }, at: T0 + 5_000 })

  const rows = text(log, T0 + 17_000)
  expect(rows[0]).toMatch(/^┄ \[ NOW \] ┄+ turn 1 · step 2$/)
  expect(rows[1]).toBe('▸ Running the width tests now.'.padEnd(W))
  expect(rows[2]).toMatch(/^ {2}test {5}bun test width +12s$/)
  expect(rows[3]).toBe(' '.repeat(W))
  expect(rows[4]).toMatch(/^┄ \[ STEPS \] ┄+ 2 steps$/)
  for (const row of rows) expect(row.length).toBe(W)
})

test('the running step`s clock ticks; nothing else in the pane changes', () => {
  let log = turnOne()

  for (let i = 0; i < 6; i++) log = step(log, `s${i}`, 'Read', { file_path: `f${i}.ts` }, ok({ file: { numLines: i } }), i * 2_000)

  log = startStep(log, { id: 'run', tool: 'Bash', input: { command: 'sleep 90' }, at: T0 + 20_000 })
  const before = text(log, T0 + 95_000)
  const after = text(log, T0 + 96_000)

  expect(before[2]).toMatch(/1m 15s$/)
  expect(after[2]).toMatch(/1m 16s$/)
  expect(after.filter((row, i) => row !== before[i])).toEqual([after[2]])
})

test('[ NOW ] with no step running says what the moment is, timed from when it began', () => {
  let log = turnOne()
  log = noteMode(log, 'requesting', T0)
  let rows = text(log, T0 + 2_000)
  expect(rows[0]).toMatch(/ turn 1$/)
  expect(rows[1]).toMatch(/^▸ Waiting for the first token\. +$/)
  expect(rows[2]).toMatch(/^ {2}waiting +2s$/)

  log = noteMode(log, 'thinking', T0 + 3_000)
  expect(text(log, T0 + 51_000)[2]).toMatch(/^ {2}thinking +48s$/)

  log = step(log, 'a', 'Read', { file_path: 'a.ts' }, ok({ file: { numLines: 3 } }), 52_000)
  // A settled step hands back to the model: `waiting`, timed from the settle, and hidden for its first second.
  expect(text(log, T0 + 56_000)[2]).toMatch(/^ {2}waiting +3s$/)
  expect(text(log, T0 + 53_500)[2]).toMatch(/^ {2}waiting +$/)
  log = noteMode(log, 'responding', T0 + 60_000)
  rows = text(log, T0 + 64_000)
  expect(rows[0]).toMatch(/ turn 1 · 1 step$/)
  expect(rows[2]).toMatch(/^ {2}writing {2}the answer +4s$/)
})

test('several tools at once: the one that started first, plus the rest as `+n`', () => {
  let log = turnOne()

  for (const [i, f] of ['held.ts', 'ledger.ts', 'store.ts'].entries()) {
    log = startStep(log, { id: f, tool: 'Read', input: { file_path: `hooks/${f}` }, at: T0 + 1_000 + i })
  }

  expect(text(log, T0 + 2_000)[2]).toMatch(/^ {2}read {5}hooks\/held\.ts \+2 +1s$/)
})

test('needs you: the label and row 1 turn to `! needs you`, row 2 is the step that asked', () => {
  let log = turnOne()
  log = startStep(log, { id: 'p', tool: 'Bash', input: { command: 'git push --force-with-lease' }, at: T0 + 1_000 })
  log = askStep(log, 'p')
  // A check the classifier answers asks nobody: no dialog, no `needs you`.
  expect(text(log, T0 + 13_000)[1]).toMatch(/^▸ /)
  let rows = paneRows(log, T0 + 13_000, W, 30, true).map(row => row.map(p => p.t).join(''))
  expect(rows[1]).toMatch(/^! needs you · permission +$/)
  expect(rows[2]).toMatch(/^ {2}shell {4}git push --force-with-lease +12s$/)

  log = settleStep(log, { id: 'p', tool: 'Bash', input: {}, outcome: ok({ stdout: '' }), at: T0 + 14_000 })
  log = startStep(log, { id: 'q', tool: 'AskUserQuestion', input: { questions: [{ header: 'How should it land?', question: 'x' }] }, at: T0 + 15_000 })
  rows = text(log, T0 + 79_000)
  expect(rows[1]).toMatch(/^! needs you · question +$/)
  expect(rows[2]).toMatch(/^ {2}ask {6}How should it land\? +1m 04s$/)
})

test('[ LAST ] when done: the state word, the story, the turn`s time; the turn and when it ended', () => {
  let log = turnOne()
  log = step(log, 'f', 'Bash', { command: 'bun test width' }, failed('Exit code 1\n 12 pass\n 2 fail\n'), 0)
  log = step(log, 'e', 'Edit', { file_path: 'a.ts' }, ok({ structuredPatch: [{ lines: ['+a'] }] }), 5_000)
  log = step(log, 'x', 'Bash', { command: 'bun test width' }, ok({ stdout: ' 14 pass\n 0 fail\n' }), 60_000)
  log = step(log, 'c', 'Bash', { command: 'git commit -m fix' }, ok({ stdout: '[main 7be09d2] fix\n' }), 120_000)
  const steps = text(log, T0 + 150_000).slice(4)
  log = endTurn(log, 164_000)

  const rows = text(log, T0 + 999_000)
  expect(rows[0]).toMatch(/^┄ \[ LAST \] ┄+ turn 1 · 10:29$/)
  expect(rows[1]).toMatch(/^ {2}done · 1 failure → fixed · ± 7be09d2 +2m 44s$/)
  expect(rows[2]).toBe(' '.repeat(W))
  // Nothing below the head rearranges at turn end (H.2).
  expect(rows.slice(3, 3 + steps.length)).toEqual(steps)
})

test('[ LAST ] when a failure is left open: `failed`, the failing step, and what to do', () => {
  let log = turnOne()
  log = step(log, 'f', 'Bash', { command: 'bun test width' }, failed('Exit code 1\n 12 pass\n 2 fail\n'), 0, 47_000)
  log = endTurn(log, 48_000)

  const rows = text(log, T0 + 99_000)
  expect(rows[1]).toMatch(/^ {2}failed · 1 failure · test bun test width +48s$/)
  expect(rows[2]).toMatch(/^ {2}ask Claude to continue +$/)
  expect(rows[3]).toBe(' '.repeat(W))
})

test('[ LAST ] after an interrupt: `interrupted` and the step that was cut, no receipt needed (correction G)', () => {
  let log = turnOne()
  log = step(log, 'a', 'Read', { file_path: 'a.ts' }, ok({ file: { numLines: 3 } }), 0)
  log = startStep(log, { id: 'b', tool: 'Bash', input: { command: 'sleep 30' }, at: T0 + 2_000 })
  log = endTurn(log, 9_000, true)

  const rows = text(log, T0 + 20_000)
  expect(rows[1]).toMatch(/^ {2}interrupted · cut at shell sleep 30 +9s$/)
  expect(rows.some(r => /interrupted +9s$/.test(r))).toBe(true)
})

test('a turn with no steps: `done · no steps`, and [ STEPS ] keeps the last turn that had any', () => {
  let log = turnOne()
  log = step(log, 'a', 'Read', { file_path: 'a.ts' }, ok({ file: { numLines: 3 } }), 0)
  log = endTurn(log, 2_000)
  log = newTurn(log, 't2', T0 + 60_000)
  log = endTurn(log, 400)

  const rows = text(log, T0 + 70_000)
  expect(rows[0]).toMatch(/ turn 2 · 10:27$/)
  expect(rows[1]).toMatch(/^ {2}done · no steps +0\.4s$/)
  expect(rows[3]).toMatch(/^┄ \[ STEPS · TURN 1 \] ┄+ 1 step$/)
  expect(rows[4]).toMatch(/^ {2}read {5}a\.ts/)
})

test('before any turn: `no turn yet`, and nothing else', () => {
  const rows = text(newLog(null, null), T0)
  expect(rows[0]).toMatch(/^┄ \[ LAST \] ┄+ no turn yet$/)
  expect(rows[1]).toMatch(/^ {2}nothing has run in this session +$/)
  expect(rows.length).toBe(2)
})

test('a pane too short for the head, one blank row and three step rows shows the head alone (amendment 2)', () => {
  let log = turnOne()

  for (let i = 0; i < 9; i++) log = step(log, `s${i}`, 'Read', { file_path: `f${i}.ts` }, ok({ file: { numLines: i } }), i * 1_000)
  log = endTurn(log, 10_000)

  expect(text(log, T0, 5).length).toBe(2)
  const fits = text(log, T0, 7)
  expect(fits.length).toBe(7)
  expect(fits[2]).toBe(' '.repeat(W))
  expect(fits[3]).toMatch(/\[ STEPS \]/)
})

// ─── The pane and the left live row, through the engine ─────────────────────

const ON = { options: { cockpit: true } }
const VIEW = { columns: 127, rows: 50, isFullscreen: true }
const PANE = {
  plugin: 'ghostframe',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'cockpit',
  props: { title: 'cockpit', isFocused: false, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 42, contentRows: 42 }, view: {} },
  viewport: VIEW
} as const
const SPINNER = {
  plugin: 'ghostframe',
  surface: 'terminal',
  component: 'Spinner',
  viewport: VIEW,
  props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' }
} as const

test('docked, the left live row is one `working` row with the turn`s time on the time edge', ON, async ($, on) => {
  let now = T0
  on('clock.now', () => ({ value: now }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))

  await $.prompt.submit({ text: 'fix the width bug', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'fix the width bug', turnId: 't1' })
  const pane = await $.ui.mount(PANE)
  now = T0 + 76_000

  const live = await $.ui.mount(SPINNER)
  const row = await live.find({ type: 'Text', text: /working/ })
  expect(row?.text).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] working +1m 16s$/)
  expect(row?.text.length).toBe(120)
  expect(await live.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await live.unmount()
  await pane.unmount()
})

test('off, the left live row is the engine`s', async ($, on) => {
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))

  const live = await $.ui.mount(SPINNER)
  expect(await live.find({ type: 'Text', text: /working/ })).toBeUndefined()
  expect((await live.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await live.unmount()
})
