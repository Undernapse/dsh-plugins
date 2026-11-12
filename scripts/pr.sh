#!/usr/bin/env bash
# Land a change on main through a pull request, end to end.
#
# The organization ruleset "Holy main" rejects direct pushes, force pushes, and
# deletion on the default branch of every Undernapse repository, so every change
# arrives through a pull request. This helper runs that loop: it branches from
# main, commits the working tree, pushes, opens the PR, and rebase-merges it.
#
# Usage: scripts/pr.sh [options] "<commit message>"
# See --help for options.
set -euo pipefail

BASE_BRANCH="main"

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
  scripts/pr.sh -d -b fix/limits "Guard against an empty provider limit"
EOF
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

if [ -z "$(git status --porcelain)" ]; then
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

echo "Branch: $branch_name"
echo "Title:  $title"

run git switch -c "$branch_name"
run git add -A
if [ -n "$body" ]; then
  run git commit -m "$subject" -m "$body"
else
  run git commit -m "$subject"
fi
run git push -u origin "$branch_name"

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

git switch "$BASE_BRANCH"
git pull --ff-only --quiet
git branch -D "$branch_name" >/dev/null 2>&1 || true
git fetch --prune --quiet || true

echo "Merged on $BASE_BRANCH: $(git log -1 --format='%h %s')"
