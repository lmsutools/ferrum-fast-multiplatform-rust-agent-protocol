#!/usr/bin/env node
/**
 * FERRUM CLI — Fast Multiplatform Rust Agent Protocol
 * F: Flat-DAG · E: Edge-Isolated · R: Reflink-Warmed · R: Ratchet-Guarded · U: Unified-Deps · M: Multi-Agent
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { warmTarget } from "../scripts/rust.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");

function runNode(script, args) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

function runShell(script, args) {
  const cmd = process.platform === "win32" && script.endsWith(".ps1") ? "powershell" : "bash";
  const res = spawnSync(cmd, [path.join(SCRIPTS, script), ...args], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

const [sub = "help", ...rest] = process.argv.slice(2);

switch (sub) {
  case "check":
  case "arch":
    runNode("check-rust-arch.mjs", rest);
    break;
  case "add-crate":
    runNode("rust-add-crate.mjs", rest);
    break;
  case "affected":
    runNode("cargo-affected.mjs", rest);
    break;
  case "sentry-triage":
  case "triage":
    runNode("sentry-triage.mjs", rest);
    break;
  case "setup":
  case "install":
    runNode("setup-all.mjs", rest);
    break;
  case "init":
  case "scaffold":
    runShell("scaffold_workspace.sh", rest);
    break;
  case "env":
    runShell(process.platform === "win32" ? "check_env.ps1" : "check_env.sh", rest);
    break;
  case "audit":
    runShell("build_audit.sh", rest);
    break;
  case "fast":
    runShell(process.platform === "win32" ? "cargo-fast.ps1" : "cargo-fast.sh", rest);
    break;
  case "remote":
    runShell("remote_build.sh", rest);
    break;
  case "vast":
    runNode("vast-cloud.mjs", rest);
    break;
  case "progress":
  case "plan":
    runNode("progress.mjs", rest);
    break;
  case "warm-target": {
    const [src, dst, mode] = rest;
    if (!src || !dst) {
      process.stderr.write("Usage: ferrum warm-target <source-repo> <worktree-dir> [clone|copy|off]\n");
      process.exit(1);
    }
    const out = warmTarget(path.resolve(src), path.resolve(dst), mode);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    break;
  }
  default:
    process.stdout.write(`FERRUM — Fast Multiplatform Rust Agent Protocol
(Flat-DAG · Edge-Isolated · Reflink-Warmed · Ratchet-Guarded · Unified-Deps · Multi-Agent)

Usage:
  ferrum init <name> [dir] --ship <os>       Scaffold a FERRUM-compliant multiplatform Rust workspace
  ferrum check [cwd] [--write-baseline|--plan] Run the <50ms 9 Golden Laws static gate or brownfield ratchet
  ferrum add-crate <name> [--cwd <dir>]      Scaffold a Beat-1 sibling adapter crate & register in root Cargo.toml
  ferrum affected --changed-list <f> -- ...  Run cargo only on affected workspace crates & transitive dependents
  ferrum warm-target <src> <worktree> [mode] Seed a git worktree with a 50ms CoW target/ clone (APFS/Btrfs/XFS)
  ferrum sentry-triage --issue <event.json>  Map a Sentry/BugSink crash stacktrace to its owning Cargo crate
  ferrum env                                 Check OS linker, RAM, disk, and macOS XProtect / Windows Dev Drive traps
  ferrum audit [--full]                      Audit build parallelism, proc-macros, duplicate deps, and critical path
  ferrum fast <build|check|run> [args...]    Opt-in nightly fast lane (-Zthreads + Cranelift in target-fast/)
  ferrum remote <ssh-host> [opts] -- <args>  Remote Linux VM / Vast.ai burst build with --install-watchdog & --poweroff
  ferrum vast <search|instances|create|stop|destroy|balance|--mcp>  Vast.ai Rust Cloud Orchestrator & MCP Server
  ferrum progress [cwd] [--init|--record|--set <id>=<pct>]  Weighted project progress & live codebase sensor engine
  ferrum setup [--home <dir>] [--dry-run]    Install FERRUM skill into Claude Code, Codex CLI, and Antigravity
`);
    process.exit(sub === "help" || sub === "--help" || sub === "-h" ? 0 : 1);
}
