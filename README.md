# DSH plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai) maintained by
Undernapse. Each subdirectory is a self-contained plugin package with its own
`README.md`, `package.json`, bundle patch, and tests.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`dsh-image-budget`](dsh-image-budget/README.md) | Keeps every model request within the image limit its provider route states, replacing the oldest images with durable references instead of sending them. |

## Install a plugin

Clone the repository, then add the plugin package directory to a profile:

```sh
git clone https://github.com/Undernapse/dsh-plugins.git
cd dsh-plugins
dsh plugin --profile <profile> add file:"$PWD/dsh-image-budget"
```

The bundle patch in each package inserts its own row into the profile, so the
plugin can also be installed as a bundle through the plugin manager
(`install_bundle` with the absolute package directory).

## Test

Each package runs its own suite with Node's built-in test runner:

```sh
cd dsh-image-budget && node --test test/
```

## License

MIT — see [LICENSE](LICENSE).
