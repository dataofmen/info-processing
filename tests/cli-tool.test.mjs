import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CliInvocation, IncompatibleFlagsError, agyCli } from '../src/cli-tool.ts';

const FIX = 'fix: use --sandbox instead of --mode plan';

test('agy accepts --sandbox with --disable-slash-commands', () => {
  const argv = ['--sandbox', '--disable-slash-commands', '--model', 'gemini-3.8-flash-low', '-p', 'prompt'];
  assert.deepEqual(agyCli.args(argv), argv);
  assert.deepEqual(new CliInvocation(agyCli, argv).argv, argv);
});

test('--mode plan alone is representable', () => {
  const argv = ['--mode', 'plan', '-p', 'prompt'];
  assert.deepEqual(new CliInvocation(agyCli, argv).argv, argv);
});

test('--mode plan with --disable-slash-commands is a no-op', () => {
  const argv = ['--mode', 'plan', '--disable-slash-commands', '-p', 'prompt'];
  assert.throws(
    () => new CliInvocation(agyCli, argv),
    (err) => {
      assert.ok(err instanceof IncompatibleFlagsError);
      assert.match(err.message, /use --sandbox instead of --mode plan/);
      return true;
    },
    FIX,
  );
  assert.throws(() => agyCli.args(argv), { name: 'IncompatibleFlagsError', message: /use --sandbox instead of --mode plan/ }, FIX);
});

test('the no-op pair is rejected in either order', () => {
  assert.throws(
    () => new CliInvocation(agyCli, ['--disable-slash-commands', '--model', 'm', '--mode', 'plan']),
    { message: /use --sandbox instead of --mode plan/ },
    FIX,
  );
});

test('runners.ts builds agy argv through CliInvocation and keeps --sandbox', () => {
  const src = fs.readFileSync(new URL('../src/llm/runners.ts', import.meta.url), 'utf8');
  assert.match(src, /new CliInvocation\(agyCli,/);
  assert.match(src, /'--sandbox'/);
  assert.doesNotMatch(src, /'--mode',\s*'plan'/, FIX);
});
