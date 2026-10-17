/**
 * A CLI tool plus one invocation.
 *
 * Incompatible flag pairs are rejected twice: the argv parameter is a type
 * error, and `new CliInvocation` throws `IncompatibleFlagsError`.
 *
 * The pair this exists for is agy `--mode plan` together with
 * `--disable-slash-commands`. That combination is a no-op (agy ignores plan
 * mode). The fix recorded on the pair is `--sandbox`.
 */

export type IncompatiblePair = readonly [left: string, right: string, fix: string];

export class IncompatibleFlagsError extends Error {
  readonly left: string;
  readonly right: string;
  readonly fix: string;

  constructor(tool: string, left: string, right: string, fix: string) {
    super(`${tool}: ${left} together with ${right} is a no-op. Fix: ${fix}`);
    this.name = 'IncompatibleFlagsError';
    this.left = left;
    this.right = right;
    this.fix = fix;
  }
}

type Split<S extends string> = S extends `${infer Head} ${infer Tail}` ? [Head, ...Split<Tail>] : [S];

type StartsWith<Args extends readonly string[], Span extends readonly string[]> = Span['length'] extends 0
  ? true
  : Args extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Span extends readonly [infer Want extends string, ...infer WantRest extends readonly string[]]
      ? [Head] extends [Want]
        ? StartsWith<Rest, WantRest>
        : false
      : false
    : false;

type HasSpan<Args extends readonly string[], Span extends readonly string[]> = Span['length'] extends 0
  ? false
  : Args extends readonly [infer Head extends string, ...infer Rest extends readonly string[]]
    ? Span extends readonly [infer Want extends string, ...infer WantRest extends readonly string[]]
      ? [Head] extends [Want]
        ? StartsWith<Rest, WantRest> extends true
          ? true
          : HasSpan<Rest, Span>
        : HasSpan<Rest, Span>
      : false
    : false;

type Hit<Args extends readonly string[], Pair> = Pair extends readonly [infer Left extends string, infer Right extends string, infer Fix extends string]
  ? HasSpan<Args, Split<Left>> extends true
    ? HasSpan<Args, Split<Right>> extends true
      ? Fix
      : never
    : never
  : never;

type Hits<Args extends readonly string[], Pairs> = Pairs extends readonly [infer Pair, ...infer Rest]
  ? Hit<Args, Pair> | Hits<Args, Rest>
  : never;

/** Valid argv stays argv. A forbidden pair becomes `{ fix: '<what to do instead>' }`, which a string array is not. */
export type Gate<Args extends readonly string[], Pairs extends readonly IncompatiblePair[]> = [Hits<Args, Pairs>] extends [never]
  ? unknown
  : { readonly fix: Hits<Args, Pairs> };

function tokens(flag: string): string[] {
  return flag.split(' ').filter((part) => part.length > 0);
}

function hasSpan(args: readonly string[], span: readonly string[]): boolean {
  if (span.length === 0 || args.length < span.length) return false;
  for (let i = 0; i <= args.length - span.length; i++) {
    let matched = true;
    for (let j = 0; j < span.length; j++) {
      if (args[i + j] !== span[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

export class CliTool<const Pairs extends readonly IncompatiblePair[]> {
  readonly name: string;
  readonly candidatePaths: readonly string[];
  readonly incompatible: Pairs;

  constructor(spec: { name: string; candidatePaths: readonly string[]; incompatible: Pairs }) {
    if (spec.name.trim() === '') throw new Error('CliTool requires a name');
    if (spec.candidatePaths.length === 0) throw new Error(`${spec.name || 'CliTool'}: candidatePaths is empty`);
    this.name = spec.name;
    this.candidatePaths = [...spec.candidatePaths];
    this.incompatible = spec.incompatible;
  }

  args<const Args extends readonly string[]>(argv: Args & Gate<Args, Pairs>): string[] {
    return new CliInvocation<Args, Pairs>(this, argv).argv;
  }
}

export class CliInvocation<const Args extends readonly string[], const Pairs extends readonly IncompatiblePair[]> {
  readonly argv: string[];

  constructor(tool: CliTool<Pairs>, argv: Args & Gate<Args, Pairs>) {
    const list = [...(argv as readonly string[])];
    for (const [left, right, fix] of tool.incompatible) {
      if (hasSpan(list, tokens(left)) && hasSpan(list, tokens(right))) {
        throw new IncompatibleFlagsError(tool.name, left, right, fix);
      }
    }
    this.argv = list;
  }
}

const agyIncompatible = [
  ['--mode plan', '--disable-slash-commands', 'use --sandbox instead of --mode plan'],
] as const satisfies readonly IncompatiblePair[];

/** Antigravity `agy`. `--sandbox` is the terminal limit; plan mode is not, once slash commands are disabled. */
export const agyCli = new CliTool({
  name: 'agy',
  candidatePaths: ['agy'],
  incompatible: agyIncompatible,
});
