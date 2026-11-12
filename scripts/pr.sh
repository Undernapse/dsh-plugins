#!/usr/bin/env bash
# Land a change on main through a pull request, end to end.
#
# The organization ruleset "Holy main" rejects direct pushes, force pushes, and
# deletion on the default branch of every Undernapse repository, so every change
# arrives through a pull request. This helper runs that loop: it branches from
# main, commits the working tree, pushes, opens the PR, and rebase-merges it.
#
# Two kinds of transient git failure are contained here rather than surfaced:
# another process holding .git/index.lock, and the sandbox occasionally failing
# to create a lock file ("Could not create new item [0x186a1]"). Reads never take
# the optional index lock, writes that hit a lock are retried with backoff, and a
# lock file is never deleted while another process might own it.
#
# Usage: scripts/pr.sh [options] "<commit message>"
# See --help for options.
set -euo pipefail

BASE_BRANCH="main"

# `git status` and friends only take the optional index lock to refresh cached
# stat data. This script never needs that refresh, and skipping it removes the
# main surface for transient lock-creation failures.
export GIT_OPTIONAL_LOCKS=0

usage() {
  cat <<'EOF'
Usage: scripts/pr.sh [options] "<commit message>"

Branches from main, commits the working tree, pushes, opens a pull request, and
rebase-merges it. The commit message's first line becomes the PR title; the rest
becomes the PR body.

Options:
  -b, --branch <name>   Branch name (default: pr/<slug of subject>)
  -t, --title <title>   PR title (default: commit subject)
  -d, --draft           Open the PR and stop, without merging
  -n, --dry-run         Print the planned commands; change nothing
  -h, --help            Show this help

Examples:
  scripts/pr.sh "Add locale strings for image-budget"
  scripts/pr.sh -d -b fix/limits "Guard against an empty limit"
EOF
}

# git_transient <stderr-file>: true when a failure is lock contention or a
# transient sandbox refusal to create a lock file, not a real problem.
git_transient() {
  grep -qiE \
    'could not create new item|unable to create .*\.lock|another git process seems to be running|index\.lock.*file exists' \
    "$1"
}

# git_retry <git args...>: run git, retrying only lock-level failures.
git_retry() {
  local attempts=4 delay=0.2 n=1 rc=0 err
  if ! err="$(mktemp "${TMPDIR:-/tmp}/dsh-plugins-git.XXXXXX")"; then
    git "$@"
    return $?
  fi
  while [ "$n" -le "$attempts" ]; do
    if git "$@" 2>"$err"; then
      # A successful command can still print the sandbox's benign lock notice.
      grep -v 'Could not create new item' "$err" >&2 || true
      rm -f "$err"
      return 0
    else
      rc=$?
    fi
    if ! git_transient "$err"; then
      cat "$err" >&2
      rm -f "$err"
      return "$rc"
    fi
    if [ "$n" -eq "$attempts" ]; then
      cat "$err" >&2
      printf 'git_retry: giving up after %d attempts\n' "$attempts" >&2
      rm -f "$err"
      return "$rc"
    fi
    printf '  ~ transient git lock failure (attempt %d/%d), retrying in %ss\n' \
      "$n" "$attempts" "$delay" >&2
    sleep "$delay"
    n=$((n + 1))
    case "$n" in
      3) delay=0.5 ;;
      4) delay=1 ;;
    esac
  done
}

branch_name=""
title=""
draft=0
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    -b|--branch)
      branch_name="${2:?--branch needs a value}"
      shift 2
      ;;
    -t|--title)
      title="${2:?--title needs a value}"
      shift 2
      ;;
    -d|--draft)
      draft=1
      shift
      ;;
    -n|--dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [ $# -ne 1 ]; then
  printf 'exactly one commit message argument is required\n\n' >&2
  usage >&2
  exit 2
fi

message="$1"
subject="$(printf '%s\n' "$message" | head -n 1)"
body="$(printf '%s\n' "$message" | tail -n +2)"

if [ -z "$subject" ]; then
  echo 'refusing: commit message is empty' >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'refusing: not inside a git work tree' >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if ! command -v gh >/dev/null 2>&1; then
  echo 'refusing: the GitHub CLI (gh) is not installed' >&2
  exit 1
fi

current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "$BASE_BRANCH" ]; then
  echo "refusing: branch '$current' is checked out; switch to '$BASE_BRANCH' first" >&2
  exit 1
fi

changes="$(git_retry status --porcelain)"
if [ -z "$changes" ]; then
  echo 'refusing: no changes to commit' >&2
  exit 1
fi

if [ -z "$branch_name" ]; then
  slug="$(printf '%s' "$subject" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-48)"
  [ -n "$slug" ] || slug="change"
  branch_name="pr/$slug"
fi

if git show-ref --verify --quiet "refs/heads/$branch_name"; then
  echo "refusing: local branch '$branch_name' already exists" >&2
  exit 1
fi

[ -n "$title" ] || title="$subject"

run() {
  if [ "$dry_run" -eq 1 ]; then
    printf '  + %s\n' "$*"
  else
    printf '  > %s\n' "$*"
    "$@"
  fi
}

run_git() {
  if [ "$dry_run" -eq 1 ]; then
    printf '  + git %s\n' "$*"
  else
    printf '  > git %s\n' "$*"
    git_retry "$@"
  fi
}

echo "Branch: $branch_name"
echo "Title:  $title"

run_git switch -c "$branch_name"
run_git add -A
if [ -n "$body" ]; then
  run_git commit -m "$subject" -m "$body"
else
  run_git commit -m "$subject"
fi
run_git push -u origin "$branch_name"

if [ "$dry_run" -eq 1 ]; then
  printf '  + gh pr create --base %s --head %s --title %s\n' "$BASE_BRANCH" "$branch_name" "$title"
  exit 0
fi

pr_body="$body"
[ -n "$pr_body" ] || pr_body="Opened with scripts/pr.sh."

if [ "$draft" -eq 1 ]; then
  gh pr create --base "$BASE_BRANCH" --head "$branch_name" \
    --title "$title" --body "$pr_body" --draft
  echo 'Draft PR opened; leaving the branch in place.'
  exit 0
fi

pr_url="$(gh pr create --base "$BASE_BRANCH" --head "$branch_name" \
  --title "$title" --body "$pr_body")"
echo "PR: $pr_url"

gh pr merge "$pr_url" --rebase --delete-branch

# The change is merged; local tidy-up problems must not read as a failed run.
git_retry switch "$BASE_BRANCH" \
  || printf 'warning: could not switch to %s; run: git switch %s\n' "$BASE_BRANCH" "$BASE_BRANCH" >&2
git_retry pull --ff-only --quiet \
  || printf 'warning: could not fast-forward %s; run: git pull --ff-only\n' "$BASE_BRANCH" >&2
git_retry branch -D "$branch_name" >/dev/null 2>&1 || true
git_retry fetch --prune --quiet || true

echo "Merged on $BASE_BRANCH: $(git log -1 --format='%h %s')"
