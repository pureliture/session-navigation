# Outgoing context: tool-result share and final-request reductions

These are captured request measurements, not a general claim about all coding agents.
Read-only analysis used actual `upstream_request.body` records, deduplicated request
IDs, compact JSON of messages plus tool schemas, and offline `o200k_base` accounting.
Provider billing tokens and this normalized token count are not interchangeable.

| A-arm capture | Requests | Median tool-result token share |
|---|---:|---:|
| v1 GLM OMP | 174 | 70.01% |
| v1 GLM Hermes | 57 | 71.40% |
| v4 DeepSeek OMP | 244 | 80.84% |
| v4 DeepSeek Hermes | 342 | 70.93% |

Wires: `eval/results/2026-11-09-glm/wire.jsonl.gz` and
`eval/results/2026-11-09-v4-deepseek/wire.jsonl.xz`; join session `spec.json`
to distinguish hosts and arms. Tool-call arguments and native summaries are
separate from tool results. This does not include a representative normal-work
local-session sample: identifiable local records were validation traffic.

For v4 B-new, restore only surviving literal plugin replacements in each of four
final outgoing requests, leaving native context management unchanged:

| Host, four final requests | Tool tokens with originals restored | Actual tool tokens | Removed |
|---|---:|---:|---:|
| OMP | 213,016 | 100,325 | 112,691 (52.90%) |
| Hermes | 336,881 | 113,803 | 223,078 (66.22%) |

Sources: final outgoing wires and the sessions' `store.json.gz`, matching exact
replacement strings and tool-call IDs. This is a restore-only counterfactual,
not a separate A run. Native `[shaken ...]` replacements are not credited to the
plugin. [v4 task checks](results-v3.md) passed 4/4 in every host/arm group;
this is no measured task-quality loss, not proof that every detail was retained.

External context: JetBrains/TUM's [The Complexity Trap](https://kairos.jetbrains.com/research/articles/the-complexity-trap)
([paper](https://arxiv.org/abs/2508.21433)) reports approximately **84% observation
tokens** in an average SWE-agent turn in preliminary SWE-bench Lite-50 experiments.
Its population and denominator differ from ours; it is not a validation of our
exact percentages.
