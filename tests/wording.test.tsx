import { expect, test } from 'claude-code/testing'

import { newLog, settleStep, startStep, stepRows } from '../hooks/steplog'
import type { Outcome } from '../hooks/steplog'

/** The result column of one settled shell step, as `[ STEPS ]` draws it at 72 columns. */
function shellResult(command: string, outcome: Outcome): string {
  const input = { command }
  const log = settleStep(startStep(newLog('t1', 0), { id: 'a', tool: 'Bash', input, at: 0 }), { id: 'a', tool: 'Bash', input, outcome, at: 1_000 })
  const row =
    stepRows(log, 72, 10)[1]
      ?.map(p => p.t)
      .join('') ?? ''

  return row
    .slice(11, -9)
    .replace(/^.*? {2,}/, '')
    .trim()
}

const out = (stdout: string): Outcome => ({ result: { stdout, stderr: '' }, text: stdout })

test('a command that succeeds with empty output reads `no output`', () => {
  expect(shellResult('mkdir -p build', out(''))).toBe('no output')
  expect(shellResult('touch a.txt', out('\n'))).toBe('no output')
})

test('a check that passes with nothing to report reads `clean`', () => {
  expect(shellResult('bun run lint', out(''))).toBe('clean')
  expect(shellResult('oxfmt --check', out(''))).toBe('clean')
  expect(shellResult('tsc -p .', out(''))).toBe('clean')
  expect(shellResult('cargo clippy', out(''))).toBe('clean')
})

test('git status: `clean`, `N changed`, `N untracked`, or `N changed +M new`', () => {
  expect(shellResult('git status', out('On branch main\nnothing to commit, working tree clean\n'))).toBe('clean')
  expect(shellResult('git status --short', out(''))).toBe('clean')
  expect(shellResult('git status --short', out(' M hooks/a.ts\nM  hooks/b.ts\n?? new.ts\n'))).toBe('2 changed +1 new')
  expect(shellResult('git status -s', out('?? a.ts\n?? b.ts\n'))).toBe('2 untracked')
  expect(
    shellResult(
      'git status',
      out(
        'On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update)\n\tmodified:   hooks/a.ts\n\tdeleted:    old.ts\n\nUntracked files:\n  (use "git add <file>..." to include)\n\tnew.ts\n'
      )
    )
  ).toBe('2 changed +1 new')
  expect(shellResult('git -C D:/x status --porcelain', out(' M a.ts\n'))).toBe('1 changed')
})

test('git diff: `+a −d` from the patch or the stat line; `no changes` when empty', () => {
  expect(shellResult('git diff', out('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx\n'))).toBe('+2 −1')
  expect(shellResult('git diff --stat', out(' a.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n'))).toBe('+2 −1')
  expect(shellResult('git diff --cached', out(''))).toBe('no changes')
})

test('ls: `N items`, `1 item`, or `empty`', () => {
  expect(shellResult('ls', out('a.txt\nb.txt\nd2\n'))).toBe('3 items')
  expect(shellResult('ls -la src', out('total 8\ndrwxr-xr-x 2 u u 4096 .\ndrwxr-xr-x 9 u u 4096 ..\n-rw-r--r-- 1 u u 12 a.ts\n'))).toBe('1 item')
  expect(shellResult('ls d2', out(''))).toBe('empty')
})

test('other commands keep their last line of output', () => {
  expect(shellResult('echo one', out('one\n'))).toBe('one')
})
