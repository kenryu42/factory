# factory

A one-person software factory that runs on GitHub Actions. You label a GitHub issue `factory`. A coding agent (Claude Code or Pi) works on it in a container and opens a pull request, a review agent reviews it, and the coding agent gets one round to fix what the review found. Label an issue `factory:spec` first to get a plan you can edit before any code is written, and label the pull request `factory:revise` to send your own review comments back to the coding agent. Every run leaves a record with its cost, tokens, and scrubbed transcripts in a private repo.

## How a run works

`examples/factory.yml` in a target repo calls `.github/workflows/run.yml` in this repo. That workflow runs `src/cli.ts` one step at a time. Each step after `guard` reads what earlier steps left in the run directory and does nothing when its stage does not apply.

1. `guard` reads the label event. It starts a run only when the repo owner added `factory` or `factory:spec` to an issue the owner wrote, or `factory:revise` to a factory pull request (see [Ask for a revision](#ask-for-a-revision)). For `factory`, it also looks for the owner's latest spec comment on the issue and takes it as the approved plan.
2. `agent 0` runs an agent inside the `docker/` image on a checkout of the target repo. The container gets one model credential and no GitHub token. For `factory:spec` it runs the spec agent on a read-only checkout; for `factory` it runs the implement agent with the issue and the approved plan.
3. `publish 0` posts the spec agent's plan as an issue comment, or copies the implement agent's files into a fresh clone, checks the diff and summary with gitleaks, and opens a pull request. It refuses changes under `.github/`.
4. `qa 0` runs the visual QA when the base commit has `.factory/qa.json` (see [Visual QA](#visual-qa)). `review 0` runs the review agent on a copy of the published tree, with the issue, the plan, the diff, and the QA report and screenshots mounted read-only. It ends with `VERDICT: approve` or `VERDICT: request_changes`. `respond 0` posts the review on the pull request.
5. When the review asks for changes, `agent 1` runs the implement agent again in the same work tree with the review in its prompt, `publish 1` pushes one more commit to the pull request, and `qa 1`, `review 1` and `respond 1` check and review it. There is never a second revise round.
6. `record` scrubs each transcript, checks it with gitleaks, and pushes `runs/<id>.json`, `transcripts/<id>/<agent>-<round>.jsonl`, and each round's `qa/<id>/<round>/qa.json` and screenshots to `<owner>/factory-runs`. A transcript that still looks like it holds a secret is withheld.

Every comment the factory posts is scrubbed of known secrets and checked with gitleaks first.

`agents/spec.md`, `agents/implement.md`, and `agents/review.md` define the run's agents: each one's prompt, default harness, and model for each harness. To pick the implement harness for one issue, add a `harness:claude-code` or `harness:pi` label before you add `factory`. The spec and review agents always use their own default, so reviews stay comparable across harnesses.

### Plan first

1. Add `factory:spec` to an issue. The spec agent posts a plan as a comment.
2. Edit that comment until the plan is what you want. Only your own comments count, so nobody else can plant a plan.
3. Add `factory`. The implement agent follows the plan, and the review agent checks the change against it.

### Ask for a revision

1. Leave comments on a pull request the factory opened: conversation comments, a review, or inline comments on the diff.
2. Add `factory:revise` to the pull request. The guard reads the pull request from the API and runs only when you added the label, the pull request is open, you opened it (the factory opens them with your token), and its head is a `factory/issue-<n>-…` branch in this repo, not a fork.
3. The implement agent runs on the pull request's head with issue `<n>`, the approved plan, and every comment you wrote after the factory's last commit on the branch. Inline comments come with their `file:line`. Comments by anyone else, and the factory's own comments (marked `<!-- factory -->`), never reach it.
4. `publish 0` pushes one commit to the same branch, fast-forward only, so a commit pushed while the agent worked makes the push fail instead of being lost. Then the review and its one revise round run as usual, with your comments in `/input/feedback.md`. The diff and the record's `baseSha` start at the merge base with the default branch.
5. The run removes the label when it starts, so add it again for another round. A run that finds no new comment from you is skipped and leaves the label in place.

The record has `kind: "revise"`, `trigger: "pr#<number>"`, and `status: "pr_updated"` when it pushed. Its `implement-0` stage is the revision you asked for.

To tie a run to a benchmark task, put `<!-- bench:<task-id> -->` in the issue body. The id is recorded as the run's `task`. Bench tasks are described under [Benchmark tasks](#benchmark-tasks).

## Score runs

`examples/score.yml` in a target repo calls `.github/workflows/score.yml` on demand. It grades every implement run in `factory-runs` that opened a PR and has no score yet (revise runs follow your feedback, so they are not graded), and pushes one file per run and scorer to `scores/<run-id>/<scorer>.json`. A score is never recomputed. Each grades the last commit the factory pushed to the PR, so later human commits do not count.

The judges also grade every bench cell whose transcript and diff were stored and that has no score yet, and push `scores/bench/<bench-id>/<cell>/<scorer>.json`. A cell's `issue.md` is its task's issue text, and its correctness is the cell's own check. Each score names what it grades in `subject`: `{ "kind": "run", "runId" }` or `{ "kind": "bench", "benchId", "cell" }`.

- `correctness` runs for runs with a bench task, read from the run's repo at its default branch. It grades a fresh copy of the PR's tree the way a bench cell is graded: the task's `setup`, then its check files and its `grade` command with no network and no credentials. The reason is the tail of the grade's output.
- Every `scorers/<name>.md` is an LLM judge for one failure mode, in the same format as the agent files. A judge reads `issue.md`, `diff.patch`, and `transcript.md` (the implement stages as readable sections) from a read-only directory and ends with `SCORE: pass` or `SCORE: fail`. Anything else, or a judge that does not finish, scores `null`. Its scrubbed transcript is stored next to the score as `<scorer>.jsonl`.

The workflow has three steps: `score-prepare` (FACTORY_GH_TOKEN) gathers the evidence, `score-judge` (model credentials only) runs the check and the judges, and `score-save` (FACTORY_GH_TOKEN) scrubs and pushes.

## Benchmark tasks

A repo's bench tasks live in that repo, on its default branch, one directory per task: `.factory/bench/tasks/<task-id>/` with a `task.md` and the hidden check files. `task.md` is frontmatter, then the issue the agent gets (a `# Title` line and the body):

```md
---
base: 0123456789abcdef0123456789abcdef01234567    # the commit the agent starts from
fix: 89abcdef0123456789abcdef0123456789abcdef     # optional: the commit that resolved it, for bench-verify
check: tests/export.test.mjs                     # files in the task dir, copied to the same path in the tree
setup: npm ci                                    # optional: runs before the agent, with network
grade: node --test --test-reporter=spec tests/export.test.mjs   # runs with no network; exit 0 passes
---
# Export drops the last row
...
```

A check file replaces the repo's own file at that path, so a task mined from history uses the fix commit's version of the test. The check is copied in after the agent finishes. No agent ever sees `.factory/bench`: the bench agent gets a one-commit clone of `base` with that directory removed, so it can neither see a check nor read the later history that holds the fix, and a factory run removes it from the agent's tree and the review's tree, and never pushes a change to it. It is also left out of the stored diff and removed from every graded tree.

`setup` installs dependencies before the agent runs, so the agent starts from a tree it can test and the grade needs no network. The tradeoff: a change that needs a new dependency fails the grade, since nothing is installed after the agent.

To add a task:

1. Pick a commit that fixed an issue and whose diff changed a test. `base` is its parent, `fix` the commit itself.
2. Copy the fix's version of each changed test file into the task directory at the same path, and list them in `check`. Name only those files in `grade`, so the rest of the suite cannot fail the task for unrelated reasons.
3. Write the issue as a user would have reported it, without naming the fix.
4. Check that the task fails at its base and passes with the fix's non-check changes, in the agent image with no model credentials, from a clone of the repo with its full history and the task in its working tree:

```sh
docker build -t factory-agent docker
node src/cli.ts bench-verify <clone of the repo> [task ids, or all]
```

5. Commit the task to the repo's default branch. A hand-written task has no `fix` and is checked by running a bench.

`kenryu42/factory-sandbox` has 16 hand-written tasks that run its whole `node --test` suite with the check added as `test/zz-bench-check.test.js`. `kenryu42/next-step-japan` has 9 tasks mined from its history, which pass `bench-verify`.

## Benchmark configs

`examples/bench.yml`, copied into a repo that has bench tasks, calls `.github/workflows/bench.yml` on demand with:

- `tasks`: ids of that repo's bench tasks separated by commas, or `all` of them.
- `configs`: `harness:model` pairs separated by commas, such as `claude-code:opus,claude-code:sonnet,pi:deepseek/deepseek-flash`.
- `factory_ref`: the ref of this repo whose `agents/implement.md` (and code) is benchmarked. The default is `main`.
- `bench_id`: the results directory. The default is the workflow run id.

The workflow checks the repo's default branch out with its full history and reads the tasks there. For each task, `bench-run` (model credentials only) makes a one-commit clone at the task's `base` and runs its `setup`. For each config it runs the implement agent on a copy with that harness and model, diffs the agent's tree against `base`, and grades it. Nothing is posted on GitHub. `bench-save` (FACTORY_GH_TOKEN) pushes `bench/<bench-id>/<task>__<harness>__<model>.json` with the scrubbed transcript (`.jsonl`) and the agent's diff (`.patch`) next to it. The diff is taken before the check is copied in, so it never holds the hidden check. A diff or transcript that gitleaks flags is withheld.

Correctness alone rarely separates two prompts once every config passes, so run the score workflow after a bench: the judges then grade each cell, and the report compares the judges' pass rates between benches.

## Improve the factory

`examples/improve.yml` in a target repo calls `.github/workflows/improve.yml` on demand. The improve agent (`agents/improve.md`) reads what the scorers, reviews, and benchmarks found, picks the one or two most frequent or costly failure patterns, and edits the agent prompts in `agents/` (never its own prompt or the judges) in a checkout of this repo to fix them. Its optional `harness` input picks claude-code or pi.

- `improve-prepare` (FACTORY_GH_TOKEN) builds `findings.md` from `factory-runs`: run counts by status, each scorer's pass/fail/unknown per implement harness, every failing score with its run or bench cell and the judge's reason, the changes the review approved that then failed correctness (with the review's text), how revise rounds turned out, and each benchmark's pass rate per config. Check output is reduced to how many of the hidden check's tests failed and which of the repo's own test files failed, so the agent never sees what the hidden checks test. It skips the run when nothing has failed yet. `node src/cli.ts findings ../factory-runs` prints the same file locally.
- `improve-run` (model credentials only) runs the agent with the checkout at `/work` and `findings.md` at `/input`.
- `improve-save` (FACTORY_GH_TOKEN) diffs the agent's tree against an untouched copy and pushes `improvements/<id>/` to `factory-runs`: `improvement.json`, `findings.md`, and, unless the proposal is blocked, `patch.diff`, `summary.md`, and the scrubbed transcript `improve.jsonl`. A change to anything but `agents/*.md`, or to `agents/improve.md`, is `blocked_scope`, and gitleaks or a known secret in the patch or summary is `blocked_secret`.

The factory's token cannot write to this repo, so you open the pull request yourself from a clean checkout of this repo:

```sh
git -C ../factory-runs pull
node src/cli.ts propose ../factory-runs <improvement-id>
```

It refuses a dirty working tree and any patch outside the graded agents' prompts in `agents/`. Otherwise it creates `improve/<id>` at the commit the agent read, applies the patch, commits it as `feat(agents): <the summary's first line>`, pushes it, and opens a pull request with the summary through your `gh` login. Before merging, run the bench with `factory_ref: improve/<id>` and compare it with `main`.

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
5. Create the labels `factory`, `factory:spec`, `factory:revise`, `harness:claude-code`, and `harness:pi`.
6. Optionally, commit a `.factory/qa.json` to turn on the [visual QA](#visual-qa).

## Visual QA

Agents and the review cannot see a browser. A target repo that serves a web app can commit `.factory/qa.json` to have each published round loaded in headless Chromium before the review:

```json
{
  "build": "bun install --frozen-lockfile && bun run build",
  "serve": "bun run start -- --port 4321 --host 127.0.0.1",
  "url": "http://localhost:4321",
  "pages": ["/", "/cities/", "/arriving-in-japan/?municipality=kobe-city"],
  "widths": [360, 390, 768, 1280],
  "schemes": ["light", "dark"]
}
```

`qa <round>` reads this file from the base commit, so a change can never loosen the checks it is judged by. In the agent image, with no credentials, it runs `build` on a copy of the published tree, starts `serve`, and loads every page at every width in each color scheme. The container has network access because the build installs packages. For each load it records how far the document scrolls sideways and the three elements that stick out furthest, console errors, same-origin 4xx and 5xx responses, and a full-page PNG screenshot. A page's query string can put a client-rendered view into the state to check.

Any overflow, console error, failed request, page that did not load, or failed build fails the QA. A failing QA makes the round's verdict `request_changes` whatever the review agent said, and the revise round gets the failures in its prompt. The review agent reads `/input/qa.md` and the screenshots in `/input/qa/`, and the PR comment for the round includes the QA summary.

To run the browser integration test, build the image and set `FACTORY_QA_IT=1`:

```sh
docker build -t factory-agent docker
FACTORY_QA_IT=1 pnpm test
```

## Query your runs

Clone `factory-runs` next to this repo, pull the latest runs, and build the report:

```sh
git -C ../factory-runs pull
node src/cli.ts report ../factory-runs
open ../factory-runs/report.html
```

`report.html` is one self-contained page that makes no network requests. It shows totals for runs, PRs, cost, merges, and reverts, then a table of runs you can filter by kind, harness, and status. Click a run to see its scores with their reasons, its stages and their review verdicts, and click a stage to read its transcript as messages, tool calls, and tool results.

Below the runs, the page shows each scorer's pass rate per implement harness and a review calibration table: the final review verdict against correctness, where approve and wrong is a defect the review missed. Each benchmark gets a table of correctness and each judge's pass rate, average cost, and average wall time per config, and a chart of pass rate against cost that marks the configs no other config beats on both. Two benches on different factory refs that ran the same task under the same config get a comparison: per config and scorer, the pass rate of each over the tasks both ran, and the difference. When one of them ran on `main`, it is A.

The report asks GitHub for each PR's state through your `gh` login. A PR counts as reverted when a merged PR in the same repo says `Reverts <repo>#<number>`, which is what GitHub's Revert button writes. Human touches are the comments, reviews, and commits on the PR by the repo owner. Bots and the factory's own commits do not count. If `gh` cannot look up a PR, the report prints a warning and leaves that run's outcome blank.

The page ends with each improvement: its status, the first line of its summary, the files it changed, and its cost.

For your own queries, build a SQLite database from the run files:

```sh
node src/cli.ts db ../factory-runs
sqlite3 ../factory-runs/runs.sqlite 'select harness, count(*), sum(cost_usd) from runs group by harness'
sqlite3 ../factory-runs/runs.sqlite 'select agent, verdict, count(*) from stages where agent = "review" group by verdict'
sqlite3 ../factory-runs/runs.sqlite 'select scorer, avg(pass), count(*) from scores where run_id is not null group by scorer'
sqlite3 ../factory-runs/runs.sqlite 'select bench_id, scorer, avg(pass), count(*) from scores where bench_id is not null group by 1, 2'
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
