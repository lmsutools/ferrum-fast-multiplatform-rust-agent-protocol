# Using Rented Remote VMs to the Max

A 64-core VM doesn't make a build 6× faster than a 10-core laptop unless the **crate
graph can use 64 cores**. Before renting anything, work through these steps in order.

---

## Step 1: Measure the build's useful parallelism (always first)

On the current machine:

```bash
cargo clean && cargo build --timings          # or --release, matching what you'll offload
python3 <skill>/scripts/timings_parallelism.py target/cargo-timings/cargo-timing.html
```

Read three numbers:

| Number | Meaning | Decision |
| :-- | :-- | :-- |
| `work` (sum of unit time) | Total CPU-seconds the build needs | Sets how long a clean build takes when cores are plentiful |
| `critical path` | Wall-time lower bound with infinite cores | No VM can beat this |
| `max useful cores = work / critical path` | Cores beyond this sit idle | **Upper limit for VM size** |

Predicted wall time on a machine with `N` cores, relative per-core speed `s`
(1.0 = current machine), ignoring I/O:

$$
T(N) \approx \frac{\max\left(\dfrac{work}{N},\ critical\_path\right)}{s}
$$

Example: work = 900 s, critical path = 60 s gives max useful cores ≈ 15. A 10-core M4
(s = 1.0) takes ~90 s. A 32-core VM with s = 0.7 takes max(28, 60) / 0.7 ≈ 86 s, which
is **no faster**. Fix the critical path first (step 2). After that, the same VM wins
easily.

> [!IMPORTANT]
> Per-core speed matters. An Apple M4 core is among the fastest available. Many cloud
> vCPUs are hyperthreads at lower clocks (s ≈ 0.5–0.8 against an M4). The incremental
> dev loop is mostly serial (one crate + link), so it's usually **faster on the local
> M4**. Remote VMs win on clean builds, full test suites, multi-target release builds,
> and CI.

---

## Step 2: Make the build able to use the cores

If `max useful cores` < the VM's cores:

1. **Shorten the critical path**: split the crates on it (architecture.md §1), move
   heavy codegen/proc-macro crates off the chain, thin the binary crate.
2. **Parallelize inside big crates** (nightly lane): `-Zthreads`. This helps exactly
   when a big crate on the critical path leaves cores idle. Don't guess the value: run
   [zthreads_sweep.sh](../scripts/zthreads_sweep.sh) on the VM and record the result in
   `PLATFORMS.md` → Build machines (reasoning in build-performance.md §7).
3. **Keep release codegen parallel**: `codegen-units = 16`, `lto = "thin"`. Fat LTO +
   `codegen-units = 1` makes the final step single-threaded.
4. **Use spare cores for independent jobs** at the same time, each with its own target
   dir: e.g. `cargo build --release --target x86_64-pc-windows-msvc`,
   `cargo nextest run`, and `cargo clippy` in parallel.

Re-run step 1 after changes. Rent big only once `max useful cores` justifies it.

---

## Step 3: Pick what to offload

| Workload | Best place | Why |
| :-- | :-- | :-- |
| Edit → check → test one crate | **Local M4** (or a remote dev box if the laptop is weak) | Mostly serial and latency-sensitive. Fast single core wins. |
| Clean builds / dependency upgrades / `cargo update` fallout | Remote VM | Wide work, uses many cores |
| Full test suite | Remote VM(s), nextest partitioned | Tests run in parallel across processes and machines |
| Release builds for Windows + macOS | CI or VMs per target, in parallel | Independent targets |
| Windows-native testing | Windows VM (Dev Drive) | You can't fully test MSVC binaries off Windows |
| macOS builds, signing, notarization | **Apple hardware** (local M4, CI macOS runner, rented Mac) | Apple SDK licensing. Cross-compiling to macOS from Linux is fragile. |

---

## Step 4: Size and configure the VM

**CPU**: choose high per-core performance over the raw vCPU count. Prefer current-gen
AMD EPYC / Intel Xeon compute-optimized or Arm (Graviton/Ampere/Axion) instances. Size
cores ≤ `max useful cores` × 1.2.

**RAM**: ≥ 2 GB per core. Use ≥ 3–4 GB per core with `-Zthreads`, LTO, or very large
crates. An OOM kill wastes the whole build. If RAM is short, cap with
`build.jobs = N` in `.cargo/config.toml` rather than starving every job.

**Disk**: local NVMe, not network block storage, for `target/` and `CARGO_HOME`. On
Linux, `tmpfs` for `target/` works if RAM allows. On Windows VMs, use a **Dev Drive**.

**OS per target** (driven by the Ship/Ready tiers in `PLATFORMS.md`):
- Linux VM: fastest builder and linker (mold/wild). It runs the cheap **Ready** checks
  for every OS (`cargo clippy --target …`), builds Linux Ship artifacts, and can
  **cross-build Windows MSVC** binaries with `cargo-xwin`. Run Windows tests on a
  Windows VM or runner.
- Windows VM: native MSVC build + test; `linker = "rust-lld.exe"`; Dev Drive.
- macOS: rented Mac minis or CI macOS runners for builds, signing, notarization.

**Toolchain**: the same pinned `rust-toolchain.toml` as local. Install `cargo-nextest`,
`sccache`, mold/wild (Linux), and `cargo-binstall` for fast tool installs.

**Ephemeral VMs** (spot/preemptible, auto-shutdown): a cold VM rebuilds everything.
Warm it with:
- `sccache` backed by S3/GCS/Azure Blob (`RUSTC_WRAPPER=sccache`, `CARGO_INCREMENTAL=0`),
  which caches dependency compilations across VMs;
- or a persistent disk / snapshot holding `CARGO_HOME` + `target/`.

---

## Step 5: Choose a workflow

### A. Remote dev box (simplest, best for weak laptops)
VS Code Remote-SSH / Zed remote / JetBrains Gateway. The source, rust-analyzer, and
cargo all run on the VM, so incremental builds stay incremental. Keep the VM in a nearby
region for low latency.

### B. Local editing, remote building (keeps the M4 for the inner loop)
- Sync with `mutagen` (or `rsync -a --delete --exclude target/`).
- Run builds over SSH:
  `ssh vm 'cd proj && cargo build --release --target x86_64-pc-windows-msvc'`
  (wrapped by [remote_build.sh](../scripts/remote_build.sh)).
- Copy back only the artifacts you need.

### C. Build once, test on many machines (CI fan-out)
```bash
cargo nextest archive --workspace --archive-file tests.tar.zst     # on the big builder
# copy tests.tar.zst to K runners, then on runner i:
cargo nextest run --archive-file tests.tar.zst --partition count:i/K
```

### D. Distributed compilation (only for very large orgs)
- `sccache-dist`: farms rustc jobs to Linux servers. Setup is complex (scheduler,
  TLS, toolchain packaging), it's network-heavy, and results are mixed when the
  workstation is already fast.
- Bazel / Buck2 with remote execution: real distributed builds and caching for huge
  monorepos, at the cost of leaving Cargo-native workflows. Consider it past roughly 1M
  LOC or 100+ engineers.

---

## Step 6: Verify you're getting your money's worth

On the VM, after a clean build:

- `timings_parallelism.py` → average core utilization should be **> 60%** for clean
  builds. If not, go back to step 2.
- Watch `htop` / `btop` during the build. Long single-core phases mean critical-path
  crates or linking.
- Compare cost per build (VM price per hour × wall time) against developer time saved.
  Shut down idle VMs automatically.

---

## Step 7: Zero-Waste VM Rules (Never Burn VM Hours While the Local LLM Reviews)

When using multi-agent orchestration (Claude / Antigravity / Codex Reviewer), the **biggest
cost trap** is leaving a 32-core Linux VM running while the LLM spends 5–20 minutes
planning, reading diffs, building decision packets, or waiting for human approval.

Enforce these **three zero-waste rules**:

### Rule 1: Strict Phase Separation (When the VM Is Allowed to Be ON)

| Workflow Phase | Where It Runs | Remote Linux VM State |
| :--- | :--- | :--- |
| **1. Architecture, Planning, Scouting & Q&A** | Local Mac | **OFF (\$0/hr)** |
| **2. Single-Crate TDD & Worker Edits (`cargo check/test -p <crate>`)** | Local Mac (with APFS CoW `warmTarget`) | **OFF (\$0/hr)** |
| **3. Heavy Multi-Target Burst (`--workspace` tests, `cargo-xwin`, `cargo-zigbuild`, clean release)** | **Remote Linux VM** (batched back-to-back) | **ON for 1–3 mins only** |
| **4. LLM Code Review, Decision Packet & User Approval** | Local Mac | **OFF (\$0/hr — powered down before review starts)** |

### Rule 2: "Burst, Fetch, and Power Off Before Review" (`--poweroff`)
Whenever the agent runs a heavy remote verification or release build before entering a
review/decision phase, pass `--poweroff` to [`remote_build.sh`](../scripts/remote_build.sh):

```bash
# Syncs source -> runs 32-core burst -> fetches artifacts -> immediately powers off VM:
scripts/remote_build.sh buildvm --poweroff \
  --fetch 'target/x86_64-pc-windows-msvc/release/*.exe' \
  -- xwin build --release --target x86_64-pc-windows-msvc
```
Because `--poweroff` triggers `systemctl poweroff` the second `rsync` finishes pulling the
artifacts/logs back to your Mac, the VM is **already off** while the local brain LLM
spends the next 10 minutes analyzing the logs and reviewing the diff.

### Rule 3: Mandatory 15-Minute Dead-Man's Switch on Every Rented VM (`--install-watchdog`)
Never rely on an agent or human remembering to shut down a VM. On the very first connection
to any rented Linux VM, install the cron watchdog built into `remote_build.sh`:

```bash
scripts/remote_build.sh buildvm --install-watchdog 15
```
- Every minute, `/usr/local/bin/rust-vm-watchdog.sh` checks if any `cargo`, `rustc`,
  `cargo-nextest`, `rust-lld`, `mold`, or `wild` process is running, or if
  `/tmp/.remote-build-heartbeat` was touched within the last 15 minutes.
- If your Mac goes to sleep, SSH drops, or the LLM gets stuck waiting on a prompt for 15
  minutes, **the VM powers itself off automatically** (stopping compute billing on Hetzner
  Cloud, AWS EC2, GCP, Azure, and Vultr when stopped/deallocated via cloud CLI or ACPI
  poweroff).
- *Provider caveat:* Confirm your cloud provider stops billing compute on OS `poweroff`
  (AWS EC2 EBS-backed, GCP, Azure when deallocated; on Hetzner/DigitalOcean, pair with a
  tiny cloud-API destroy/snapshot hook if the provider bills powered-off instances).

---

## Step 8: Vast.ai On-Demand Instances & MCP Server Playbook (`ferrum-vast-mcp` / `vastai-mcp`)

Vast.ai offers 32–128 core AMD EPYC / Threadripper machines (with optional GPUs for
CUDA / WGPU / Candle / Burn workloads) at **\$0.12–\$0.45/hr**, controllable directly by
AI agents via **Model Context Protocol (MCP)** servers.

### 1. Three Critical Vast.ai Differences (Avoid These Traps!)
1. **Vast.ai instances are Docker containers, NOT full kernel VMs:**
   - Inside a Vast.ai container, `/sbin/poweroff` and `systemctl poweroff` **do not stop Vast.ai billing**.
   - To stop billing, you **must** call the Vast.ai API (`PUT /api/v0/instances/$CONTAINER_ID/ {"state":"stopped"}` or `DELETE` to destroy).
   - Both [`scripts/vast-cloud.mjs`](../scripts/vast-cloud.mjs) (`buildVastOnstartScript`) and [`scripts/remote_build.sh`](../scripts/remote_build.sh) (`--vast-id <id> --poweroff` / `--destroy` / `--install-watchdog`) handle this automatically via the Vast.ai REST API!
2. **Don't Rent a \$1.50/hr GPU Attached to a Weak 4-Core CPU:**
   - Standard Vast.ai searches sort by GPU TFLOPS. For Rust compilation, filter by:
     - `cpu_cores_effective >= 32` (or `>= 64`)
     - `cpu_ram >= 64` GB ($\ge 2\text{ GB}$ RAM per effective core so `rustc` + `lld` never OOM)
     - `disk_bw >= 500` MB/s (fast NVMe for `target/`)
     - `reliability >= 0.98`
   - `ferrum vast search` (`vast_search_rust_offers` MCP tool) automatically filters for these constraints and ranks offers by **`Effective CPU Cores per Dollar`**.
3. **Custom SSH Ports (`ssh://root@ssh5.vast.ai:41892`):**
   - Vast.ai assigns a high port (`-p 41892`) per container. `scripts/remote_build.sh` natively accepts full `ssh://root@ssh5.vast.ai:41892` URLs or `--port <port>` and passes `-p` to both `ssh` and `rsync -e`.

### 2. Using the Built-In `ferrum-vast-mcp` Server & Community MCP Servers
FERRUM ships a zero-dependency Vast.ai MCP server (`scripts/vast-cloud.mjs --mcp`, auto-registered in Antigravity by `npm run setup`) and works alongside community MCP packages (`vastai-mcp` / `vast-mcp-server`).

**Setup your API key once:**
```bash
export VAST_API_KEY="your-vast-api-key"
# or persist for both CLI and MCP servers:
echo "your-vast-api-key" > ~/.vast_api_key && chmod 600 ~/.vast_api_key
```

**Built-in MCP Tools (`ferrum-vast-mcp`) & CLI equivalents (`node bin/ferrum.mjs vast ...`):**

| MCP Tool Name | CLI Command | When the Agent Calls It |
| :--- | :--- | :--- |
| `vast_balance` | `ferrum vast balance` | Before starting a wave—checks credit balance and current hourly burn rate (`$/hr`). |
| `vast_search_rust_offers` | `ferrum vast search --min-cores 32 --min-ram 64` | Finds the highest `coresPerDollar` EPYC/Threadripper offers (add `--gpu RTX_4090` if testing CUDA/WGPU crates). |
| `vast_create_rust_instance` | `ferrum vast create <offerId> --idle-mins 15` | Launches `rust:latest` (or CUDA image), installs `lld`/`mold`/`rsync`, and starts the 15-min Vast.ai API self-stop watchdog. |
| `vast_list_instances` | `ferrum vast instances` | Returns active instances, their `ssh://root@sshX.vast.ai:PORT` URL, and the exact `ferrum remote` command to run. |
| `vast_stop_instance` | `ferrum vast stop <instanceId>` | Stops compute billing immediately right before the local LLM begins reviewing build/test output. |
| `vast_destroy_instance` | `ferrum vast destroy <instanceId>` | Destroys the instance completely at the end of a sprint so storage billing also drops to \$0. |

### 3. End-to-End Burst Workflow on Vast.ai
```bash
# 1. Find the best 32+ core Rust build offer on Vast.ai:
node bin/ferrum.mjs vast search --min-cores 32 --min-ram 64 --max-dph 0.50

# 2. Launch the offer (auto-installs lld/mold + 15-minute Vast.ai API idle watchdog):
node bin/ferrum.mjs vast create <OFFER_ID> --disk 40 --idle-mins 15

# 3. Get the SSH URL and ready-to-run command:
node bin/ferrum.mjs vast instances

# 4. Run the 32-core burst build/test, fetch artifacts, and immediately STOP Vast.ai billing before LLM review:
node bin/ferrum.mjs remote ssh://root@ssh5.vast.ai:41892 --vast-id <INSTANCE_ID> --poweroff \
  -- nextest run --workspace --profile ci
```

## Decision checklist (copy into the project plan)

- [ ] `max useful cores` measured: ____
- [ ] Critical-path crates identified and split (target: utilization > 60% on the VM)
- [ ] VM: ____ vCPU, ____ GB RAM (≥ 2 GB/core), local NVMe (XFS/Btrfs) / Dev Drive
- [ ] Targets per machine: Linux VM (lint, test, Windows `cargo-xwin` + `wine64`) · Mac (native macOS test, sign, notarize)
- [ ] Cache: sccache + object storage, or a persistent disk
- [ ] Workflow: A / B / C / D
- [ ] Dead-man's switch installed (`remote_build.sh <host> --install-watchdog 15`) + `--poweroff` used before LLM review phases
