# factory

A one-person software factory that runs on GitHub Actions. You label a GitHub issue `factory`. A coding agent (Claude Code, Codex, or Pi) works on it in a container and opens a pull request. Every run leaves a record with its cost, tokens, and scrubbed transcript in a private repo.

## How a run works

`examples/factory.yml` in a target repo calls `.github/workflows/run.yml` in this repo. That workflow runs `src/cli.ts` one step at a time:

1. `guard` reads the issue event. It starts a run only when the repo owner added the `factory` label to an issue the owner wrote.
2. `agent` runs the harness inside the `docker/` image on a checkout of the target repo. The container gets one model key and no GitHub token.
3. `publish` copies the agent's files into a fresh clone, checks the diff and summary with gitleaks, and opens a pull request. It refuses changes under `.github/`.
4. `record` scrubs the transcript, checks it with gitleaks, and pushes `runs/<id>.json` and `transcripts/<id>.jsonl` to `<owner>/factory-runs`. A transcript that still looks like it holds a secret is withheld.

`agents/implement.md` defines the agent: its prompt, the default harness, and the model for each harness. To pick a harness for one issue, add a `harness:claude-code`, `harness:codex`, or `harness:pi` label before you add `factory`.

## Set up a target repo

1. Create a fine-grained personal access token with access to the target repo and `factory-runs`. Give it read and write access to **Contents**, **Pull requests**, and **Issues**. Do not give it **Workflows** access, so an agent's change to `.github/workflows` can never be pushed.
2. Add the secrets to the target repo:

	```sh
	gh secret set FACTORY_GH_TOKEN -R <owner>/<repo>
	gh secret set ANTHROPIC_API_KEY -R <owner>/<repo>   # claude-code
	gh secret set DEEPSEEK_API_KEY -R <owner>/<repo>    # pi
	gh secret set OPENAI_API_KEY -R <owner>/<repo>      # codex
	```

	Use keys made only for the factory, each with a hard spend limit. Never use a subscription login.
3. Copy `examples/factory.yml` to `.github/workflows/factory.yml` in the target repo.
4. In the target repo settings under **Actions**, set workflow permissions to read-only and require approval for workflows from all outside contributors.
5. Create the labels `factory`, `harness:claude-code`, `harness:codex`, and `harness:pi`.

## Query your runs

Clone `factory-runs`, then build a SQLite database from its run files:

```sh
node src/cli.ts db ../factory-runs
sqlite3 ../factory-runs/runs.sqlite 'select harness, count(*), sum(cost_usd) from runs group by harness'
```

Codex runs record tokens but no cost, because Codex reports no price.

## Develop

Node 24 runs the TypeScript directly, so there is no build step.

```sh
pnpm install
pnpm typecheck
pnpm test
```

The tests parse real transcripts from each harness in `test/fixtures/`.
