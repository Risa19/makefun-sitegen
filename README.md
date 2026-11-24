# makefun-sitegen

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Risa19/makefun-sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Risa19/makefun-sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0, written for the make.fun
`site-generator-speed-01` competition ("Build a static site faster").

`run(input)` in `solve.js` returns exactly the output tree makefun-site
1.0.0's `build()` returns for the same input — every page's `index.html`,
the index and tag pages, `build-report.txt`, and each static file, byte
for byte — but builds it roughly twice as fast.

## Layout

- `solve.js` — the generator. Dependency-free ES module, `run(input)`
  returns the output tree (a plain object of path to file text).
- `main.ts` — the driver the harness runs: reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.
  Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
  stand in for `/input` and `/output`.
- `warmup.js` — a small synthetic site the driver builds a few times
  before the real cases, so the JIT has the hot functions compiled when
  the real builds start. Fixed synthetic data; its output is discarded
  and nothing from it is carried into any case.
- `package.json` — `{"type": "module"}`.

## How it is faster

The reference spends most of its time escaping HTML one character at a
time, building Markdown token objects it then renders, and re-slugifying
the same titles and tags. This implementation:

- escapes HTML in bulk: a fast test returns strings without `& < > " '`
  unchanged, and plain runs of inline text are escaped in one call
  instead of per character;
- renders Markdown in one fused pass — lexing and rendering together,
  with no token objects — dispatching on each line's first character so
  plain-text lines never call a classifier;
- parses inline markup with `indexOf` jumps instead of a
  character-by-character scan, with a proven parity rule for escaped
  closers (a closer is escaped exactly when the run of backslashes
  before it has odd length);
- slugifies with an ASCII fast path (NFKD is the identity on ASCII) and
  memoises slugs and long dates per build — never across cases;
- parses front matter by scanning line boundaries with `indexOf`,
  slicing the body instead of splitting and rejoining the whole file;
- renders templates with a shared output array, integer node kinds, a
  scope stack, and one reused vars/loop object per `for` node (saved
  and restored around the body, so self-including templates stay
  correct);
- skips the `\r\n` normalisation pass when a file holds no `\r`, and
  counts words without allocating a match array.

## Measured speed

On the kit's practice set (3 cases, 1,070 Markdown sources, 7.4 MB of
output), user CPU over 7 alternating runs in a fresh process each time:

| entry | median | mean |
| --- | --- | --- |
| makefun-site 1.0.0 (house baseline) | 1.301 s | 1.303 s |
| this entry | 0.709 s | 0.680 s |

About 1.8–1.9x faster, with identical output.

## Correctness

- The kit's own scorer passes the practice set 3/3.
- 45 further cases drawn from the kit's generator with fresh random
  seeds: 45/45 identical to the reference oracle.
- 38 hand-written adversarial cases (escaped closers, unclosed
  constructs, malformed front matter, self-including templates, Unicode
  slugs, pagination, shadowing): 38/38 identical.
- Two runs of the entry on the same input produce byte-identical
  output.

## Licence

MIT — see `LICENSE`.
