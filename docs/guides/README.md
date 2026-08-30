# Guides

User documentation for Adze. For the reasoning behind the design, read
[docs/architecture/](../architecture/README.md) and the
[decision records](../architecture/adr/README.md) instead.

| Guide | Read it when |
| --- | --- |
| [getting-started.md](getting-started.md) | You have just cloned the repository. Install, build, configure a provider — including a free local one — run your first task, and learn what each of the six commands does. Also the plain list of what Adze cannot do yet. |
| [configuration.md](configuration.md) | You want to bound what an agent can do. The two-axis permission model, command-prefix rules, budgets, model selection, and `.adze/providers.json`. |
| [local-testing.md](local-testing.md) | You are on Windows and want to try Adze without regretting it. A launcher with restrictive defaults that refuses to run outside a git repository. |
| [plugins.md](plugins.md) | You want to encode a team policy without forking. The eight first-party plugins, the deny-capable hook, and how to write your own. |
| [embedding.md](embedding.md) | You want to build your own surface — a CLI, an extension, a daemon, a bot — on `@adze/sdk`. |

Every command shown in these guides was run against the built binary before being
written down, and quoted output is that run's real output. Where a capability does not
work yet, the guide says so and names the milestone in
[the roadmap](../roadmap.md) rather than describing it as working.

## Two things to know before you start

**There is no OS-level sandbox containment on any platform.** Not Windows, and not
macOS or Linux either. The permission gate is the only enforcement that exists, and it
decides *whether* a command runs — nothing constrains what it touches once it does.
Treat an approval as equivalent to running the command yourself.
[ADR-0007](../architecture/adr/0007-sandbox-and-permissions.md).

**No benchmark result has been published.** The harness and the
[policy](../benchmarks/strategy.md) exist; no number does. The policy was written
before the first measurement on purpose, so it could not be bent to fit one.
