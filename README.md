# DSH plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai) maintained by
Undernapse. Each subdirectory is a self-contained plugin package with its own
`README.md`, `package.json`, bundle patch, and tests.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`dsh-tracker-issue-workflow`](dsh-tracker-issue-workflow/README.md) | Right-click a GitHub, Forgejo, Gitea, or GitHub Enterprise issue link to start `/ugo`, `/ufast`, or `/uloop` on it, in a new session or the current one. |
| [`dsh-web-search-searxng`](dsh-web-search-searxng/README.md) | Searches the web through a SearXNG instance, and shows the sites each search cited in Chat. |

## Install a plugin

Clone the repository, then add the plugin package directory to a profile:

```sh
git clone https://github.com/Undernapse/dsh-plugins.git
cd dsh-plugins
dsh plugin --profile <profile> add file:"$PWD/dsh-web-search-searxng"
```

The bundle patch in each package inserts its own row into the profile, so the
plugin can also be installed as a bundle through the plugin manager
(`install_bundle` with the absolute package directory).

## Test

Each package runs its own suite with Node's built-in test runner:

```sh
cd dsh-web-search-searxng && node --test test/
```

## Contributing

`main` is protected by the organization's **Holy main** ruleset, so every change
lands through a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md), or let the
helper run the loop:

```sh
scripts/pr.sh "Add locale strings for web search"
```

## License

MIT — see [LICENSE](LICENSE).
