# factory

A one-person software factory that runs on GitHub Actions. You label a GitHub issue `factory`. A coding agent (Claude Code or Pi) works on it in a container and opens a pull request, a review agent reviews it, and the coding agent gets one round to fix what the review found. Label an issue `factory:spec` first to get a plan you can edit before any code is written. Every run leaves a record with its cost, tokens, and scrubbed transcripts in a private repo.

## How a run works

`examples/factory.yml` in a target repo calls `.github/workflows/run.yml` in this repo. That workflow runs `src/cli.ts` one step at a time. Each step after `guard` reads what earlier steps left in the run directory and does nothing when its stage does not apply.

1. `guard` reads the issue event. It starts a run only when the repo owner added `factory` or `factory:spec` to an issue the owner wrote. For `factory`, it also looks for the owner's latest spec comment on the issue and takes it as the approved plan.
2. `agent 0` runs an agent inside the `docker/` image on a checkout of the target repo. The container gets one model credential and no GitHub token. For `factory:spec` it runs the spec agent on a read-only checkout; for `factory` it runs the implement agent with the issue and the approved plan.
3. `publish 0` posts the spec agent's plan as an issue comment, or copies the implement agent's files into a fresh clone, checks the diff and summary with gitleaks, and opens a pull request. It refuses changes under `.github/`.
4. `review 0` runs the review agent on a copy of the published tree, with the issue, the plan, and the diff mounted read-only. It ends with `VERDICT: approve` or `VERDICT: request_changes`. `respond 0` posts the review on the pull request.
5. When the review asks for changes, `agent 1` runs the implement agent again in the same work tree with the review in its prompt, `publish 1` pushes one more commit to the pull request, and `review 1` and `respond 1` review it. There is never a second revise round.
6. `record` scrubs each transcript, checks it with gitleaks, and pushes `runs/<id>.json` and `transcripts/<id>/<agent>-<round>.jsonl` to `<owner>/factory-runs`. A transcript that still looks like it holds a secret is withheld.

Every comment the factory posts is scrubbed of known secrets and checked with gitleaks first.

`agents/spec.md`, `agents/implement.md`, and `agents/review.md` define the run's agents: each one's prompt, default harness, and model for each harness. To pick the implement harness for one issue, add a `harness:claude-code` or `harness:pi` label before you add `factory`. The spec and review agents always use their own default, so reviews stay comparable across harnesses.

### Plan first

1. Add `factory:spec` to an issue. The spec agent posts a plan as a comment.
2. Edit that comment until the plan is what you want. Only your own comments count, so nobody else can plant a plan.
3. Add `factory`. The implement agent follows the plan, and the review agent checks the change against it.

To tie a run to a benchmark task, put `<!-- bench:<task-id> -->` in the issue body. The id is recorded as the run's `task`. Each task in `bench/tasks/<task-id>/` has the issue text (`task.md`) and a hidden check (`check.test.js`) that the agent never sees.

## Score runs

`examples/score.yml` in a target repo calls `.github/workflows/score.yml` on demand. It grades every implement run in `factory-runs` that opened a PR and has no score yet, and pushes one file per run and scorer to `scores/<run-id>/<scorer>.json`. A score is never recomputed. Each grades the last commit the factory pushed to the PR, so later human commits do not count.

- `correctness` runs for runs with a bench task. It copies the task's check into a fresh copy of the graded tree as `test/zz-bench-check.test.js` and runs `node --test` in the agent image with no network and no credentials. It passes only when the whole suite passes, so breaking the repo's own tests fails too. The reason is the tail of the test output.
- Every `scorers/<name>.md` is an LLM judge for one failure mode, in the same format as the agent files. A judge reads `issue.md`, `diff.patch`, and `transcript.md` (the implement stages as readable sections) from a read-only directory and ends with `SCORE: pass` or `SCORE: fail`. Anything else, or a judge that does not finish, scores `null`. Its scrubbed transcript is stored next to the score as `<scorer>.jsonl`.

The workflow has three steps: `score-prepare` (FACTORY_GH_TOKEN) gathers the evidence, `score-judge` (model credentials only) runs the check and the judges, and `score-save` (FACTORY_GH_TOKEN) scrubs and pushes.

## Benchmark configs

`examples/bench.yml`, copied into `factory-sandbox`, calls `.github/workflows/bench.yml` on demand with:

- `tasks`: bench task ids separated by commas, or `all`.
- `configs`: `harness:model` pairs separated by commas, such as `claude-code:haiku,pi:deepseek/deepseek-v4-flash`.
- `factory_ref`: the ref of this repo whose `agents/implement.md` (and code) is benchmarked. The default is `main`.
- `bench_id`: the results directory. The default is the workflow run id.

For each task and config, `bench-run` (model credentials only) copies one fixed commit of the target repo's default branch, runs the implement agent on the task's issue text with that harness and model, and grades the tree with the task's check. Nothing is posted on GitHub. `bench-save` (FACTORY_GH_TOKEN) pushes `bench/<bench-id>/<task>__<harness>__<model>.json` and the scrubbed transcript next to it.

## Improve the factory

`examples/improve.yml` in a target repo calls `.github/workflows/improve.yml` on demand. The improve agent (`agents/improve.md`) reads what the scorers, reviews, and benchmarks found, picks the one or two most frequent or costly failure patterns, and edits the agent prompts in `agents/` (never its own prompt or the judges) in a checkout of this repo to fix them. Its optional `harness` input picks claude-code or pi.

- `improve-prepare` (FACTORY_GH_TOKEN) builds `findings.md` from `factory-runs`: run counts by status, each scorer's pass/fail/unknown per implement harness, every failing score with its run and the judge's reason, the changes the review approved that then failed correctness (with the review's text), how revise rounds turned out, and each benchmark's pass rate per config. Check output is reduced to how many of the hidden check's tests failed and which of the repo's own test files failed, so the agent never sees what the hidden checks test. It skips the run when nothing has failed yet. `node src/cli.ts findings ../factory-runs` prints the same file locally.
- `improve-run` (model credentials only) runs the agent with the checkout at `/work` and `findings.md` at `/input`.
- `improve-save` (FACTORY_GH_TOKEN) diffs the agent's tree against an untouched copy and pushes `improvements/<id>/` to `factory-runs`: `improvement.json`, `findings.md`, and, unless the proposal is blocked, `patch.diff`, `summary.md`, and the scrubbed transcript `improve.jsonl`. A change to anything but `agents/*.md`, or to `agents/improve.md`, is `blocked_scope`, and gitleaks or a known secret in the patch or summary is `blocked_secret`.

The factory's token cannot write to this repo, so you open the pull request yourself from a clean checkout of this repo:

```sh
git -C ../factory-runs pull
node src/cli.ts propose ../factory-runs <improvement-id>
```

It refuses a dirty working tree and any patch outside `agents/` and `scorers/`. Otherwise it creates `improve/<id>` at the commit the agent read, applies the patch, commits it as `feat(agents): <the summary's first line>`, pushes it, and opens a pull request with the summary through your `gh` login. Before merging, run the bench with `factory_ref: improve/<id>` and compare it with `main`.

## Set up a target repo

1. Create a fine-grained personal access token with access to the target repo and `factory-runs`. Give it read and write access to **Contents**, **Pull requests**, and **Issues**. Do not give it **Workflows** access, so an agent's change to `.github/workflows` can never be pushed.
2. Add the secrets to the target repo:

	```sh
	gh secret set FACTORY_GH_TOKEN -R <owner>/<repo>
	gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/<repo>   # claude-code on your Claude subscription
	gh secret set ANTHROPIC_API_KEY -R <owner>/<repo>         # claude-code on API billing
	gh secret set DEEPSEEK_API_KEY -R <owner>/<repo>          # pi
	```

	`CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token` and bills your Claude plan's usage. When it is set, the factory uses it instead of `ANTHROPIC_API_KEY` and records each stage's billing as `subscription`. Use API keys made only for the factory, each with a hard spend limit.
3. Copy `examples/factory.yml` to `.github/workflows/factory.yml` in the target repo.

	The example runs on GitHub-hosted `ubuntu-latest`. To run on your own Mac, uncomment its `with:` block, which selects a self-hosted runner labeled `factory`. Do that only in repos where you alone can open pull requests, as GitHub's [security guidance for self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use) explains. The Mac needs Docker, git, and gh on the runner's PATH.
4. In the target repo settings under **Actions**, set workflow permissions to read-only and require approval for workflows from all outside contributors.
5. Create the labels `factory`, `factory:spec`, `harness:claude-code`, and `harness:pi`.

## Query your runs

Clone `factory-runs` next to this repo, pull the latest runs, and build the report:

```sh
git -C ../factory-runs pull
node src/cli.ts report ../factory-runs
open ../factory-runs/report.html
```

`report.html` is one self-contained page that makes no network requests. It shows totals for runs, PRs, cost, merges, and reverts, then a table of runs you can filter by kind, harness, and status. Click a run to see its scores with their reasons, its stages and their review verdicts, and click a stage to read its transcript as messages, tool calls, and tool results.

Below the runs, the page shows each scorer's pass rate per implement harness and a review calibration table: the final review verdict against correctness, where approve and wrong is a defect the review missed. Each benchmark gets a table of pass rate, average cost, and average wall time per config, and a chart of pass rate against cost that marks the configs no other config beats on both.

The report asks GitHub for each PR's state through your `gh` login. A PR counts as reverted when a merged PR in the same repo says `Reverts <repo>#<number>`, which is what GitHub's Revert button writes. Human touches are the comments, reviews, and commits on the PR by the repo owner. Bots and the factory's own commits do not count. If `gh` cannot look up a PR, the report prints a warning and leaves that run's outcome blank.

The page ends with each improvement: its status, the first line of its summary, the files it changed, and its cost.

For your own queries, build a SQLite database from the run files:

```sh
node src/cli.ts db ../factory-runs
sqlite3 ../factory-runs/runs.sqlite 'select harness, count(*), sum(cost_usd) from runs group by harness'
sqlite3 ../factory-runs/runs.sqlite 'select agent, verdict, count(*) from stages where agent = "review" group by verdict'
sqlite3 ../factory-runs/runs.sqlite 'select scorer, avg(pass), count(*) from scores group by scorer'
sqlite3 ../factory-runs/runs.sqlite 'select bench_id, harness, requested_model, avg(pass), avg(cost_usd) from bench group by 1, 2, 3'
sqlite3 ../factory-runs/runs.sqlite 'select id, status, changed_files, cost_usd from improvements'
```

Both commands write generated files into the `factory-runs` checkout. Do not commit `report.html` or `runs.sqlite`; add them to that repo's `.gitignore`.

## Develop

Node 24 runs the TypeScript directly, so there is no build step.

```sh
pnpm install
pnpm typecheck
pnpm test
```

The tests parse real transcripts from each harness in `test/fixtures/`. The correctness tests run `node --test` on small repos in a temp directory.
