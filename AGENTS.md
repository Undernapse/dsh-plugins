# Project instructions

This repository collects DeepSeek Harness plugins. Each top-level directory is a
self-contained package with its own `package.json`, bundle patch, tests, and
`README.md`; read the package README before changing it, and keep a change
scoped to one plugin unless it is repository-wide.

## uworkflow

Development here follows the uworkflow skills, installed under
`~/.agents/skills`:

- `ugo` — route a request to the workflow that fits it.
- `uplan` — triage and plan work in issues.
- `utickets` — turn discussion and findings into a tracked hierarchy.
- `uship` — implement tracked work in isolated worktrees, then review it.
- `ufast` — deliver a small change that needs no test or compilation.
- `uloop` — run the whole loop: issue, PR, independent review, QA, report.
- `ureview` — review a PR, diff, or file scope independently.
- `uaudit` — audit and file findings as issues.
- `uworkflow` — the shared rules, gates, and tracking templates.

### Git server and tracker

- Git server: GitHub at `https://github.com`, repository
  [Undernapse/dsh-plugins](https://github.com/Undernapse/dsh-plugins).
- Tracker: [GitHub Issues for Undernapse/dsh-plugins](https://github.com/Undernapse/dsh-plugins/issues).
- `main` is protected by the organization ruleset **Holy main**: every change
  lands through a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md), or run
  `scripts/pr.sh` to do the whole loop.

### Checks

- Run the affected package's suite: `cd <plugin> && node --test test/`.
- Keep credentials, tokens, and personal absolute paths out of the diff. This
  repository is public.

### Related repositories

None established. Each package is installed into a local DSH profile and has no
dependency on another repository.
