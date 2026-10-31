# CI Cost Control: Hosted CI Gates, Vast.ai Bursts, Local Inner Loop

Hosted CI minutes on private repos are metered. GitHub Free includes 2,000 minutes a
month, and each runner OS counts at a different rate. Large Rust workspaces with OS
matrices run out of that allowance fast. When there's no payment method, GitHub
**blocks** jobs ("recent account payments have failed or your spending limit needs to be
increased") instead of billing. Every PR then shows red checks that ran for 0 seconds.

FERRUM rule: **hosted CI is a cheap gate, not the build farm.** Heavy work goes to the
local Mac (when warm) or a Vast.ai burst (when wide).

---

## 1. Know the meter

| Runner | GitHub list price | Minutes counted against Free allowance |
| :-- | :-- | :-- |
| Linux (2-core) | $0.006/min | 1× |
| Windows | $0.010/min | 2× |
| macOS (3-core) | $0.062/min | **10×** |
| Vast.ai 32–44 core EPYC/Xeon | $0.14–0.30/**hour** | n/a (≈ $0.0025–0.005/min for ~15× the cores) |

Measured example (Direktor, October 2026): 1,572 Linux + 31 macOS + 70 Windows minutes
came to 2,022 counted minutes. That exhausted the free tier, and every new run was then blocked.
One macOS job-minute counts as much as ten Linux minutes.

Check usage before it bites: `github.com/settings/billing/usage` (group by SKU), or
`gh api /users/<user>/settings/billing/usage` (needs `gh auth refresh -s user`).

---

## 2. Placement table (what runs where)

| Work | Where | Why |
| :-- | :-- | :-- |
| `cargo check/clippy/test -p <crate>`, warm incremental clippy | **Local Mac** | Fastest single core, warm `target/`. Free |
| Fast static gates: `xtask layers`, `fences`, `gateway-fence`, `cargo deny`, fmt | **Hosted CI, Linux only**, on `pull_request` | Minutes are cheap. Gives the PR a visible status |
| Full `--workspace` nextest, doctests, clean builds, dependency upgrades | **Vast.ai burst** (Workflow D) | Wide work. 37 cores for ~$0.18/hr, auto-stopped |
| Windows build + Ready-tier checks | **Vast.ai Linux + `cargo-xwin`** | Avoids 2× Windows minutes |
| Windows-native test (MSVC runtime behavior) | Hosted Windows runner on **release tags only**, or a Windows VM | Rarely needed per PR |
| macOS build, sign, notarize, Metal/wgpu pixel tests | **Local Mac** | 10× hosted cost. Apple hardware is already on the desk |
| Nightly fuzz / long benches | Vast.ai burst on demand (`workflow_dispatch`), never `schedule` on private repos | A daily cron burns ~30 days × job length |

---

## 3. Workflow triggers for every FERRUM Rust repo

```yaml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]          # not feature/**: pushes to WIP branches cost minutes and gate nothing
  workflow_dispatch:

concurrency:                  # a new push cancels the stale run on the same ref
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

- **Paths filter**: skip CI when only `docs/**`, `*.md`, or `assets/**` changed
  (`paths-ignore`). Doc-heavy agent waves otherwise trigger full Rust runs.
- **OS matrix** (`windows-latest`, `macos-latest`) only under `if: startsWith(github.ref, 'refs/tags/v')`
  or `workflow_dispatch`.
- **`[skip ci]`** in agent commit messages for ledger/progress/docs-only commits.
- **Timeouts**: `timeout-minutes:` on every job. A hung headless-UI test can otherwise
  run for the 6-hour default.
- **Cache**: `Swatinem/rust-cache` with `save-if: ${{ github.ref == 'refs/heads/main' }}`.
  PR runs restore without writing, which keeps cache storage (also metered) small.

---

## 4. The burst replaces the heavy CI job

The agent runs this before asking for review (see [remote-vm-builds.md §7–8](remote-vm-builds.md)):

```bash
ferrum vast balance                                   # credit + current burn
ferrum vast search --min-cores 32 --min-ram 64 --max-dph 0.30
ferrum vast create <offer> --disk 80 --idle-mins 15   # watchdog stops billing after 15 idle minutes
# provision once: same toolchain pin as CI (dtolnay/rust-toolchain@X), nextest, mold, CI apt packages
rsync tracked files only (git ls-files -z | rsync --from0 --files-from=-), never target/
ssh … 'cargo nextest run --profile ci <CI crate set>'   # same commands the hosted job would run
ferrum vast stop <id>                                 # before the LLM starts reading logs
```

Post the burst result on the PR (`gh pr comment`) so reviewers see the green run that
the hosted CI didn't do. Destroy the instance at the end of the sprint so storage billing
also drops to $0.

Typical cost: a full workspace test burst of 15–25 min on a $0.18/hr box costs $0.05–0.08.

---

## 5. Local disk guard (the Mac is part of the build farm)

A 60+ GB `target/` on a 228 GB disk can hit `ENOSPC` mid-test. When that happens, every
tool on the machine stops, the agent's shell included. Before any local `--workspace` run:

```bash
df -h /System/Volumes/Data | awk 'NR==2{print $4}'    # need ≥ 25 GB free for a full test build
du -sh target
cargo sweep --time 7          # drop artifacts unused for 7 days
rm -rf target/debug/incremental   # safe: rebuilt on demand, costs one slower build
```

Rule: if free space is under 25 GB, or `target/` is over 40 GB, **send the workspace test
run to Vast.ai instead of running it locally.**

---

## 6. Spending guardrails

- GitHub: if a card is ever added, create an **Actions budget** ($0–5) with "stop usage
  when budget limit is reached". Budgets are off by default, which means unlimited.
- Vast.ai: `--idle-mins 15` on every create. Check `ferrum vast instances` at the end of
  every session. The 0-instance state is the expected resting state.
- Report spend per session: Vast credit before and after, plus the GitHub included-usage
  percentage.

## Decision checklist (per repo)

- [ ] Hosted workflows: `pull_request` + `main` only, `concurrency` cancel, `paths-ignore` docs
- [ ] OS matrix gated to tags / dispatch; no `schedule` on private repos
- [ ] Heavy test job reproduced as a `ferrum vast` burst script with the same commands
- [ ] macOS-only checks (Metal pixel diffs, `fences` macOS baseline) run locally
- [ ] Disk guard before local workspace runs
- [ ] GitHub Actions budget set (if a payment method exists)
