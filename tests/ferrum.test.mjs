import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  affectedPackages,
  parseCargoCounts,
  rustDiagnostics,
  runsRust,
  warmJobTarget,
  warmTarget,
  withSelection,
} from "../scripts/rust.mjs";
import { checkRustArchitecture, writeArchBaseline, buildBrownfieldPlan } from "../scripts/check-rust-arch.mjs";
import { addSiblingCrate } from "../scripts/rust-add-crate.mjs";
import { buildSentryTriage } from "../scripts/sentry-triage.mjs";
import { setupAllAgents } from "../scripts/setup-all.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ferrum-test-"));
let seq = 0;
const tmp = label => {
  const dir = path.join(TMP_ROOT, `${label}-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("cargo and nextest test counts parse accurately", () => {
  const cargoOut = [
    "running 3 tests",
    "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    "Doc-tests foo",
    "test result: FAILED. 1 passed; 2 failed; 0 ignored",
  ].join("\n");
  assert.deepEqual(parseCargoCounts(cargoOut), { pass: 4, fail: 2, format: "cargo" });

  const nextestOut = "    Summary [   0.412s] 18 tests run: 16 passed, 1 failed, 1 timed out, 2 skipped";
  assert.deepEqual(parseCargoCounts(nextestOut), { pass: 16, fail: 2, format: "nextest" });
});

test("rustc, clippy, rustfmt, and test panic diagnostics are extracted with cwd-relative paths", () => {
  const stderr = [
    "warning: unused import: `std::fmt`",
    " --> crates/domain/src/lib.rs:4:5",
    "  = note: `#[warn(unused_imports)]` on by default",
    "error[E0308]: mismatched types",
    " --> /ws/crates/app/src/lib.rs:19:9",
    "thread 'orders::rejects_zero' panicked at crates/app/src/lib.rs:44:9:",
    "assertion `left == right` failed",
  ].join("\n");
  const d = rustDiagnostics(stderr, "/ws");
  assert.equal(d.errors, 1);
  assert.equal(d.warnings, 1);
  assert.equal(d.diagnostics[0].level, "error");
  assert.equal(d.diagnostics[0].code, "E0308");
  assert.equal(d.diagnostics[0].file, "crates/app/src/lib.rs");
  assert.equal(d.failedTests[0].name, "orders::rejects_zero");
  assert.equal(d.failedTests[0].file, "crates/app/src/lib.rs");
  assert.equal(d.failedTests[0].line, 44);

  const fmtOut = "Diff in /ws/crates/domain/src/lib.rs:12:\n- foo()\n+ bar()\n";
  const fmtDiag = rustDiagnostics(fmtOut, "/ws");
  assert.deepEqual(fmtDiag.unformatted, ["crates/domain/src/lib.rs"]);
});

test("affectedPackages selects owning crates plus transitive workspace dependents and escalates on global configs", () => {
  const pkg = (name, deps = []) => ({
    id: `${name} 0.1.0`,
    name,
    manifest_path: `/ws/crates/${name}/Cargo.toml`,
    dependencies: deps.map(d => ({ name: d, path: `/ws/crates/${d}` })),
  });
  const meta = {
    workspace_root: "/ws",
    workspace_members: ["domain 0.1.0", "app 0.1.0", "http 0.1.0", "cli 0.1.0"],
    packages: [pkg("domain"), pkg("app", ["domain"]), pkg("http", ["app"]), pkg("cli", ["app"])],
  };
  assert.deepEqual(affectedPackages(meta, ["crates/http/src/lib.rs"], "/ws").packages, ["http"]);
  assert.deepEqual(affectedPackages(meta, ["crates/app/src/lib.rs"], "/ws").packages, ["app", "cli", "http"]);
  assert.equal(affectedPackages(meta, ["crates/domain/src/lib.rs"], "/ws").mode, "workspace");
  assert.equal(affectedPackages(meta, [".config/nextest.toml"], "/ws").mode, "workspace");
  assert.equal(affectedPackages(meta, [".sqlx/query-1.json"], "/ws").mode, "workspace");
  assert.equal(affectedPackages(meta, ["proto/api.proto"], "/ws").mode, "workspace");
  assert.equal(affectedPackages(meta, ["README.md"], "/ws").mode, "none");

  const sel = { mode: "packages", packages: ["app", "http"] };
  assert.deepEqual(
    withSelection(["clippy", "--all-targets", "--", "-D", "warnings"], sel),
    ["clippy", "--all-targets", "-p", "app", "-p", "http", "--", "-D", "warnings"],
  );
  assert.ok(runsRust({ command: "node", args: ["/path/cargo-affected.mjs"] }));
});

test("warmTarget clones debug artifacts via CoW while skipping rust-analyzer, release, dist, and .cargo-lock", () => {
  const repo = tmp("warm-repo"), wt = tmp("warm-wt");
  git(repo, ["init", "--quiet", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "Cargo.toml"), "[workspace]\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "/target\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  git(repo, ["worktree", "add", "--quiet", "--detach", wt]);

  fs.mkdirSync(path.join(repo, "target/debug/deps"), { recursive: true });
  fs.mkdirSync(path.join(repo, "target/rust-analyzer/debug"), { recursive: true });
  fs.mkdirSync(path.join(repo, "target/release"), { recursive: true });
  fs.writeFileSync(path.join(repo, "target/.cargo-lock"), "locked");
  fs.writeFileSync(path.join(repo, "target/.rustc_info.json"), "{}");
  fs.writeFileSync(path.join(repo, "target/debug/deps/libfoo.rlib"), "artifact");
  fs.writeFileSync(path.join(repo, "target/rust-analyzer/debug/ra.rlib"), "ide-only");
  fs.writeFileSync(path.join(repo, "target/release/app"), "rel-only");

  const res = warmJobTarget(repo, wt, git);
  if (process.platform === "darwin") assert.equal(res.status, "cloned");
  assert.ok(fs.existsSync(path.join(wt, "target/debug/deps/libfoo.rlib")));
  assert.ok(fs.existsSync(path.join(wt, "target/.rustc_info.json")));
  assert.ok(!fs.existsSync(path.join(wt, "target/rust-analyzer")));
  assert.ok(!fs.existsSync(path.join(wt, "target/release")));
  assert.ok(!fs.existsSync(path.join(wt, "target/.cargo-lock")));
});

test("FERRUM 9 Golden Laws, Brownfield Ratchet Mode, and Beat-1 addSiblingCrate work end-to-end", () => {
  const ws = tmp("ferrum-ws");
  const scaffold = path.join(ROOT, "scripts/scaffold_workspace.sh");
  const res = spawnSync("bash", [scaffold, "ferrum-demo", ws, "--ship", "macos", "--ready", "windows,linux"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const project = path.join(ws, "ferrum-demo");

  // 1. Freshly scaffolded workspace passes all 9 Golden Laws
  assert.equal(checkRustArchitecture(project).ok, true);

  // 2. Beat 1: add sibling adapter crate `billing`
  const added = addSiblingCrate("billing", { cwd: project });
  assert.equal(added.pkgName, "ferrum-demo-billing");
  assert.deepEqual(added.scope, ["crates/billing/**"]);
  assert.equal(checkRustArchitecture(project).ok, true);

  // 3. Unit struct with #[derive(Debug)] does not leak state into subsequent non-Debug struct
  const billingSrc = path.join(project, "crates/billing/src/lib.rs");
  fs.writeFileSync(
    billingSrc,
    [
      "#[derive(Debug)]",
      "pub struct UnitMarker;",
      "",
      "pub struct NonDebugSecret {",
      "    pub api_key: String,",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(checkRustArchitecture(project).ok, true);

  // 4. Inject violations across workspace & semantic laws
  fs.appendFileSync(path.join(project, "crates/app/Cargo.toml"), '\nserde = { workspace = true, features = ["derive"] }\n');
  fs.writeFileSync(path.join(project, "crates/app/tests/extra.rs"), "#[test] fn extra() {}\n");
  fs.appendFileSync(path.join(project, "crates/app/src/lib.rs"), '\n#[cfg(target_os = "windows")]\npub fn leaked() {}\n');
  fs.appendFileSync(path.join(project, "crates/domain/Cargo.toml"), '\n[dependencies]\ntokio = { workspace = true }\n');
  fs.appendFileSync(path.join(project, "crates/store-memory/Cargo.toml"), '\n[dependencies]\nferrum-demo-telemetry = { workspace = true }\n');
  fs.writeFileSync(
    billingSrc,
    [
      "#[derive(Clone, Debug)]",
      "pub struct StripeConfig {",
      "    pub api_key: String,",
      "}",
      "",
      "pub async fn charge() {",
      "    let (_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<u32>();",
      "    std::thread::sleep(std::time::Duration::from_millis(10));",
      "}",
      "",
    ].join("\n"),
  );

  const audit = checkRustArchitecture(project);
  assert.equal(audit.ok, false);
  const rules = audit.violations.map(v => v.rule).sort();
  assert.deepEqual(rules, [
    "arch::no_blocking_in_async",
    "arch::no_unbounded_channels",
    "arch::no_unredacted_secrets",
    "arch::no_workspace_feature_thrash",
    "arch::platform_cfg_isolation",
    "arch::pure_domain",
    "arch::sibling_adapter_isolation",
    "arch::single_integration_test_binary",
  ]);

  // 5. Brownfield Ratchet Mode: freeze 8 legacy violations, verify 0 new violations pass, then catch a 9th new violation
  const plan = buildBrownfieldPlan(project);
  assert.equal(plan.totalViolations, 8);
  assert.equal(plan.phases.length, 5);

  const baseline = writeArchBaseline(project);
  assert.equal(baseline.count, 8);
  const ratcheted = checkRustArchitecture(project);
  assert.equal(ratcheted.ok, true);
  assert.equal(ratcheted.baselinedCount, 8);

  fs.appendFileSync(path.join(project, "crates/store-memory/src/lib.rs"), "\n#[cfg(unix)]\npub fn new_leak() {}\n");
  const afterNew = checkRustArchitecture(project);
  assert.equal(afterNew.ok, false);
  assert.equal(afterNew.newViolations.length, 1);
  assert.equal(afterNew.newViolations[0].rule, "arch::platform_cfg_isolation");
});

test("buildSentryTriage maps Sentry stacktrace frames to Cargo crates and setupAllAgents links skills idempotently", () => {
  const pkg = (name, deps = []) => ({
    id: `${name} 0.1.0`,
    name,
    manifest_path: `/ws/crates/${name}/Cargo.toml`,
    dependencies: deps.map(d => ({ name: d })),
  });
  const meta = {
    workspace_root: "/ws",
    workspace_members: ["acme-domain 0.1.0", "acme-app 0.1.0"],
    packages: [pkg("acme-domain"), pkg("acme-app", ["acme-domain"])],
  };
  const issue = {
    shortId: "SENTRY-99",
    title: "panic: index out of bounds",
    latestEvent: {
      exception: {
        values: [{
          type: "Panic",
          value: "index out of bounds",
          stacktrace: {
            frames: [
              { filename: "/rustc/123/library/core/src/panicking.rs", lineno: 50, in_app: false },
              { abs_path: "/ws/crates/acme-app/src/lib.rs", function: "acme_app::process", lineno: 42, in_app: true },
            ],
          },
        }],
      },
    },
  };
  const triage = buildSentryTriage(issue, { cwd: "/ws", metadata: meta });
  assert.deepEqual(triage.affected.direct, ["acme-app"]);
  assert.equal(triage.codexStart.isolation, "worktree");

  const fakeHome = tmp("home");
  const summary = setupAllAgents({ homeDir: fakeHome, repoRoot: ROOT });
  assert.equal(summary.protocol, "FERRUM");
  assert.equal(summary.skills.length, 3);
  for (const s of summary.skills) assert.equal(s.status, "linked");
  const second = setupAllAgents({ homeDir: fakeHome, repoRoot: ROOT });
  for (const s of second.skills) assert.equal(s.status, "unchanged");

  const help = spawnSync(process.execPath, [path.join(ROOT, "bin/ferrum.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /FERRUM — Fast Multiplatform Rust Agent Protocol/);
});
