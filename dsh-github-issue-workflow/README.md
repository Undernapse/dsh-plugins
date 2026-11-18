# GitHub issue workflow

Right-click a GitHub issue link and start the development workflow on it,
either in a new session or in the one you are reading.

The menu appears on issue links rendered by the Web page: Markdown links in a
reply, and links in web tool results. Pull request links and other hosts keep
the ordinary menu, because these commands do not take them.

## Using it

Right-click `https://github.com/owner/repo/issues/12` and pick a command:

| Command | What it starts |
| --- | --- |
| `/ugo` | Route the issue to the right workflow skill. |
| `/ufast` | Deliver a tightly scoped change to a reviewed pull request. |
| `/uloop` | Run the autonomous delivery loop through review and QA. |

Each command then asks where to run:

- **In a new session** — a session opens in the current workspace with
  `/ufast https://github.com/owner/repo/issues/12` typed in the composer.
  Nothing runs until you send it, so you can adjust the prompt first. A draft
  already sitting in that composer is replaced.
- **In this session** — the command is sent to the session whose link you
  clicked, as a queued turn, and starts right away. Clicking the menu while
  that session is mid-turn queues the command behind the current turn.

The command line always carries the canonical issue URL, without a fragment or
tracking query.

## Where the menu is registered

The plugin contributes to the Web context-menu service for `url` targets, the
same service the built-in "Open link" actions use, with `order: 300` so it
sits below them. The Client half is the whole feature; the Host row only makes
it load.

## Commands and copy

The command list is `COMMANDS` at the top of `client.js`, one line per
command, and the labels are the `command.*` entries of the locale
dictionaries in the same file. Adding `/uplan` is one entry plus one label per
locale. No Host configuration is read, so the patch row stays empty.

## Install

From this directory:

```sh
dsh plugin --profile <profile> add file:"$PWD"
```

or install the directory as a bundle through the plugin manager
(`install_bundle` with the absolute package path). The bundle patch inserts the
row `github-issue-workflow` and the Client half registers itself at boot.

## Test

```sh
node --test test/
```

The suite loads `client.js` through a stand-in for the browser module loader,
so it exercises the shipped menu registration: which links it offers, the
text it builds, and both delivery paths.
