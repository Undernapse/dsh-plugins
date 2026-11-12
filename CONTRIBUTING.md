# Contributing

This repository collects DeepSeek Harness plugins. Each top-level directory is a
self-contained plugin package with its own `package.json`, bundle patch, and
tests. Keep a change scoped to one plugin unless it is repository-wide.

## Pull requests are required

`main` is protected by the organization ruleset **Holy main**: direct pushes,
force pushes, and deletion are rejected on the default branch of every
Undernapse repository, and changes must arrive through a pull request. A PR
needs no approving review, so you can merge your own once the checks pass.

## The flow

```sh
git switch main && git pull --ff-only
git switch -c pr/<short-slug>
# edit...
git add -A && git commit -m "Imperative subject" -m "Why this change is needed."
git push -u origin pr/<short-slug>
gh pr create --base main --head pr/<short-slug> --fill
gh pr merge --rebase --delete-branch
```

Or let [`scripts/pr.sh`](scripts/pr.sh) run the whole loop from a clean `main`
checkout:

```sh
scripts/pr.sh "Add locale strings for image-budget"
```

It refuses to run outside `main` or without changes, uses the commit message's
first line as the PR title and the rest as the body, and rebase-merges the PR.
Use `--dry-run` to preview the commands, `--draft` to stop after opening the PR,
and `--branch` / `--title` to override the generated names.

### Transient git failures

Another process refreshing the index, or the file sandbox refusing to create a
lock file, can make a single git call fail even though the repository is healthy.
The helper contains that instead of failing the run:

- read-only commands run with `GIT_OPTIONAL_LOCKS=0`, so they never write the index;
- lock-level failures (`.git/index.lock`, `Could not create new item [0x186a1]`)
  are retried up to four times with backoff;
- the sandbox's benign creation notice is dropped when the call succeeded;
- real errors are printed unchanged and are never retried.

A lock file is never deleted: another process may still own it.

## Checks

Run the affected plugin's suite before opening a PR:

```sh
cd <plugin> && node --test test/
```

Review the diff for credentials, tokens, and personal absolute paths: this
repository is public.
