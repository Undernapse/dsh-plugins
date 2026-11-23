# Tracker issue workflow

Right-click an issue link and start the development workflow on it, either in a
new session or in the one you are reading.

The menu appears on issue links from GitHub, GitHub Enterprise, Forgejo, and
Gitea — the trackers the workflow skills drive. It appears on links rendered by
the Web page: Markdown links in a reply, and links in web tool results. Pull
request links and other pages keep the ordinary menu, because these commands do
not take them.

## Using it

Right-click an issue link, such as `https://github.com/owner/repo/issues/12` or
`https://git.example.org/owner/repo/issues/12`, and pick a command:

| Command | What it starts |
| --- | --- |
| `Route this issue (/ugo)` | Route the issue to the right workflow skill. |
| `Small change (/ufast)` | Deliver a tightly scoped change to a reviewed pull request. |
| `Deliver autonomously (/uloop)` | Run the autonomous delivery loop through review and QA. |

Each command then asks where to run:

- **Open a new session and run** — a session opens in the Workspace at the
  clicked Session's directory (else the most recent Workspace), the command is
  put in its composer, and the composer submits it through the same path as
  pressing Enter, so `/ufast` resolves to the workflow skill and the turn
  starts without another click. Before any Workspace exists the command is left
  unsent in the new session's composer instead, because the Host needs a
  Workspace to attach the Session.
- **Open a new session (not sent)** — a session opens in the current or most
  recent workspace with `/ufast <issue URL>` typed in the composer. Nothing runs
  until you send it, so you can adjust the prompt first. The command is appended
  after any draft already sitting in that composer, never in place of it.
- **Send to this session now** — the command is sent to the session whose link
  you clicked, as a queued turn. It starts immediately when that session is
  idle and runs after the current turn when it is busy; the toast says which
  happened.

The command line always carries the canonical issue URL, without a fragment or
tracking query: the clicked host, port, and scheme are kept, so a Forgejo issue
on a self-hosted instance reaches the workflow unchanged. A session that can no
longer receive a message (for example after it was closed in the page) is
offered only the two new-session destinations.

## Which links get the menu

A link is an issue when its path is `/<owner>/<repo>/issues/<n>` with an
optional trailing path. All four supported trackers serve an issue at that
shape on their own host, so the rule reads the path and never needs a list of
instances: a Forgejo or Gitea deployment on any domain works without
configuration.

These stay out:

- pull request paths (`/pull/12`, Forgejo's `/pulls/12`);
- GitLab's `/-/issues/` form, whose separator adds a path segment;
- single-segment pages such as `https://redmine.example.org/issues/12`, and
  deeper paths such as `https://gitlab.com/group/sub/project/-/issues/12`;
- anything that is not an `http` or `https` link.

The rule is the path shape, so a host that serves a lookalike path — Redmine's
`/projects/<name>/issues/12`, for example — is treated as a tracker. Nothing in
the URL distinguishes it from a Forgejo owner named `projects`. An instance
mounted under a sub-path, such as `https://example.org/forgejo/owner/repo/issues/12`,
is not detected, because the prefix adds a segment. Both are the cost of
recognising self-hosted instances without configuration.

## Where the menu is registered

The plugin contributes to the Web context-menu service for `url` targets, the
same service as the built-in Open in sidebar, Open in external browser, and
Copy link address actions, with `order: 300` so it sits below them. The Client
half is the whole feature; the Host row only makes it load. It reads the
Workspace and Session list snapshots to choose where a new Session goes, and
uses the Workspace service to create or reuse the blank before opening it.

## Commands, copy, and languages

The command list is `COMMANDS` at the top of `client.js`, one line per
command, and the labels are the `command.*` entries of the locale dictionaries
in the same file. Adding `/uplan` is one entry plus one label per language.
No Host configuration is read, so the patch row stays empty.

The menu and the plugin details are translated into every language the
application ships: Chinese, English, Japanese, Spanish, French, German,
Russian, and Portuguese (`client.js` plus `locale/*.json`).

## Install

From this directory:

```sh
dsh plugin --profile <profile> add file:"$PWD"
```

or install the directory as a bundle through the plugin manager
(`install_bundle` with the absolute package path). The bundle patch inserts the
row `tracker-issue-workflow` and the Client half registers itself at boot.

### Renamed from `dsh-github-issue-workflow`

The package was named `@undernapse/dsh-github-issue-workflow` up to 0.2.1. A
profile that still lists that bundle keeps a row named
`github-issue-workflow` pointing at a directory this repository no longer has,
so remove that bundle row (or the `file:` entry that added it) and install this
package instead. The menu, its commands, and its copy are otherwise unchanged;
the issue links it covers are wider.

## Test

```sh
node --test test/
```

The suite loads `client.js` through a stand-in for the browser module loader,
so it exercises the shipped menu registration: which links it offers, the
text it builds, the run and draft new-session paths, the current-session
delivery path, and the destination it withholds when the session cannot receive
a message.
