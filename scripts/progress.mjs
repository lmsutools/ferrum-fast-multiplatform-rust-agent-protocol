#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { checkRustArchitecture } from "./check-rust-arch.mjs";

const PLAN_FILENAME = ".ferrum-plan.json";

function walkRustFiles(dir, excludeFiles = [], out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRustFiles(full, excludeFiles, out);
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      if (excludeFiles.some(pat => entry.name === pat || entry.name.endsWith(pat) || full.includes(pat))) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function stripInlineTestModule(src) {
  const idx = src.search(/#\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
  return idx >= 0 ? src.slice(0, idx) : src;
}

/**
 * Evaluate a live codebase sensor to compute deterministic progress in [0.0, 1.0].
 */
export function evaluateSensor(root, sensor) {
  if (!sensor || typeof sensor !== "object") return null;

  if (sensor.type === "pattern_burndown") {
    const targetDir = path.resolve(root, sensor.dir || ".");
    const excludeFiles = sensor.excludeFiles || ["tests.rs", "_tests.rs", "/tests/"];
    const files = walkRustFiles(targetDir, excludeFiles);
    const regex = new RegExp(sensor.pattern, "g");
    let currentCount = 0;

    for (const file of files) {
      let content = fs.readFileSync(file, "utf8");
      if (sensor.excludeTestMods !== false) {
        content = stripInlineTestModule(content);
      }
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) continue;
        const matches = trimmed.match(regex);
        if (matches) currentCount += matches.length;
      }
    }

    const start = Number(sensor.startCount ?? currentCount);
    const target = Number(sensor.targetCount ?? 0);
    if (start <= target) {
      return {
        progress: currentCount <= target ? 1 : 0,
        detail: `${currentCount}/${target} matches`,
        currentCount,
      };
    }
    const raw = (start - currentCount) / (start - target);
    const progress = Math.max(0, Math.min(1, raw));
    return {
      progress,
      detail: `${currentCount} remaining (from ${start} -> ${target})`,
      currentCount,
    };
  }

  if (sensor.type === "ferrum_law_burndown") {
    const { violations } = checkRustArchitecture(root);
    const code = sensor.code || "*";
    const matching = code === "*"
      ? violations
      : violations.filter(v => (v.rule || v.code) === code || String(v.rule || v.code).startsWith(code));
    const currentCount = matching.length;
    const start = Number(sensor.startCount ?? currentCount);
    const target = Number(sensor.targetCount ?? 0);
    if (start <= target) {
      return {
        progress: currentCount <= target ? 1 : 0,
        detail: `${currentCount} violations (${code})`,
        currentCount,
      };
    }
    const raw = (start - currentCount) / (start - target);
    const progress = Math.max(0, Math.min(1, raw));
    return {
      progress,
      detail: `${currentCount} violations remaining (from ${start} -> ${target})`,
      currentCount,
    };
  }

  if (sensor.type === "file_exists") {
    const paths = Array.isArray(sensor.paths) ? sensor.paths : [];
    if (paths.length === 0) return { progress: 1, detail: "0/0 files" };
    const found = paths.filter(p => fs.existsSync(path.resolve(root, p))).length;
    return {
      progress: found / paths.length,
      detail: `${found}/${paths.length} files present`,
      currentCount: found,
    };
  }

  return null;
}

/**
 * Build a default universal `.ferrum-plan.json` for any Rust workspace.
 */
export function buildDefaultPlan(root) {
  const absRoot = path.resolve(root);
  const { violations } = checkRustArchitecture(absRoot);
  const projectName = path.basename(absRoot);

  const countByPrefix = prefix => violations.filter(v => String(v.rule || v.code).startsWith(prefix)).length;
  const profileCount = countByPrefix("arch::fast_compile_profiles") + countByPrefix("arch::workspace_lints");
  const thrashCount = countByPrefix("arch::no_workspace_feature_thrash");
  const dagCount =
    countByPrefix("arch::max_workspace_depth") +
    countByPrefix("arch::sibling_adapter_isolation") +
    countByPrefix("arch::single_integration_test_binary") +
    countByPrefix("arch::platform_cfg_isolation");
  const safetyCount =
    countByPrefix("safety::") +
    countByPrefix("perf::") +
    countByPrefix("sec::");

  return {
    schemaVersion: 1,
    project: projectName,
    baselinePct: 0,
    lastTurnPct: null,
    updatedAt: new Date().toISOString(),
    deferredScope: [],
    pillars: [
      {
        id: "P1",
        name: "Compile & Link Acceleration (Phase 0)",
        items: [
          {
            id: "P1.1",
            title: "Fast dev/release/dist profiles & workspace lints",
            weight: 15,
            status: profileCount === 0 ? "completed" : "in_progress",
            progress: profileCount === 0 ? 1 : 0,
            sensor: {
              type: "ferrum_law_burndown",
              code: "arch::fast_compile_profiles",
              startCount: Math.max(1, profileCount),
              targetCount: 0,
            },
          },
          {
            id: "P1.2",
            title: "Zero workspace feature thrash across crates",
            weight: 10,
            status: thrashCount === 0 ? "completed" : "in_progress",
            progress: thrashCount === 0 ? 1 : 0,
            sensor: {
              type: "ferrum_law_burndown",
              code: "arch::no_workspace_feature_thrash",
              startCount: Math.max(1, thrashCount),
              targetCount: 0,
            },
          },
        ],
      },
      {
        id: "P2",
        name: "Crate DAG & Multi-Core Parallelism",
        items: [
          {
            id: "P2.1",
            title: "DAG depth <= 4, sibling isolation, single integration binary & platform cfg isolation",
            weight: 25,
            status: dagCount === 0 ? "completed" : "in_progress",
            progress: dagCount === 0 ? 1 : 0,
            sensor: {
              type: "ferrum_law_burndown",
              code: "arch::",
              startCount: Math.max(1, violations.filter(v => String(v.rule || v.code).startsWith("arch::")).length),
              targetCount: 0,
            },
          },
        ],
      },
      {
        id: "P3",
        name: "Runtime Safety, Async & Security Laws",
        items: [
          {
            id: "P3.1",
            title: "Zero undocumented unsafe, zero blocking in async, bounded channels & redacted secrets",
            weight: 20,
            status: safetyCount === 0 ? "completed" : "in_progress",
            progress: safetyCount === 0 ? 1 : 0,
            sensor: {
              type: "ferrum_law_burndown",
              code: "*",
              startCount: Math.max(1, violations.length),
              targetCount: 0,
            },
          },
        ],
      },
      {
        id: "P4",
        name: "Product Features & Multi-Platform Acceptance",
        items: [
          {
            id: "P4.1",
            title: "Core domain & application feature milestones",
            weight: 20,
            status: "in_progress",
            progress: 0.5,
          },
          {
            id: "P4.2",
            title: "Multi-platform test & release verification (Linux / macOS / Windows / Wasm)",
            weight: 10,
            status: "pending",
            progress: 0,
          },
        ],
      },
    ],
  };
}

/**
 * Evaluate a FERRUM plan object against the workspace and return full weighted metrics.
 */
export function evaluatePlan(root, plan) {
  const absRoot = path.resolve(root);
  let totalWeight = 0;
  let totalEarned = 0;
  const pillarSummaries = [];
  const nextActions = [];

  for (const pillar of plan.pillars || []) {
    let pillarWeight = 0;
    let pillarEarned = 0;
    const evaluatedItems = [];

    for (const item of pillar.items || []) {
      if (item.status === "deferred") {
        evaluatedItems.push({ ...item, effectiveProgress: 0, earnedWeight: 0, sensorDetail: "deferred" });
        continue;
      }
      const weight = Number(item.weight || 0);
      let effectiveProgress = Number(item.progress ?? (item.status === "completed" ? 1 : 0));
      let sensorDetail = item.note || null;

      if (item.status === "completed") {
        effectiveProgress = 1;
      } else if (item.sensor) {
        const res = evaluateSensor(absRoot, item.sensor);
        if (res) {
          effectiveProgress = res.progress;
          sensorDetail = res.detail;
        }
      }
      effectiveProgress = Math.max(0, Math.min(1, effectiveProgress));
      const earned = Math.round(weight * effectiveProgress * 1000) / 1000;
      const derivedStatus =
        effectiveProgress >= 0.9999
          ? "completed"
          : effectiveProgress > 0
            ? "in_progress"
            : item.status || "pending";

      pillarWeight += weight;
      pillarEarned += earned;
      totalWeight += weight;
      totalEarned += earned;

      const evaluated = {
        id: item.id,
        title: item.title,
        weight,
        earnedWeight: Math.round(earned * 100) / 100,
        progressPct: Math.round(effectiveProgress * 1000) / 10,
        status: derivedStatus,
        sensorDetail,
      };
      evaluatedItems.push(evaluated);

      if (derivedStatus !== "completed") {
        const remainingWeight = Math.round((weight - earned) * 100) / 100;
        nextActions.push({
          id: item.id,
          pillarId: pillar.id,
          title: item.title,
          remainingWeight,
          progressPct: evaluated.progressPct,
          sensorDetail,
        });
      }
    }

    const pillarPct = pillarWeight > 0 ? Math.round((pillarEarned / pillarWeight) * 1000) / 10 : 100;
    pillarSummaries.push({
      id: pillar.id,
      name: pillar.name,
      weight: Math.round(pillarWeight * 100) / 100,
      earned: Math.round(pillarEarned * 100) / 100,
      pct: pillarPct,
      items: evaluatedItems,
    });
  }

  const overallPct = totalWeight > 0 ? Math.round((totalEarned / totalWeight) * 10000) / 100 : 0;
  const baselinePct = Number(plan.baselinePct ?? 0);
  const lastTurnPct = plan.lastTurnPct !== null && plan.lastTurnPct !== undefined
    ? Number(plan.lastTurnPct)
    : baselinePct;
  const turnDeltaPct = Math.round((overallPct - lastTurnPct) * 100) / 100;
  const baselineDeltaPct = Math.round((overallPct - baselinePct) * 100) / 100;

  nextActions.sort((a, b) => b.remainingWeight - a.remainingWeight);

  return {
    project: plan.project || path.basename(absRoot),
    overallPct,
    totalEarned: Math.round(totalEarned * 100) / 100,
    totalWeight: Math.round(totalWeight * 100) / 100,
    baselinePct,
    lastTurnPct,
    turnDeltaPct,
    baselineDeltaPct,
    progressBar: renderProgressBar(overallPct, 24),
    pillars: pillarSummaries,
    nextHighLeverageItems: nextActions.slice(0, 6),
    deferredScope: plan.deferredScope || [],
  };
}

export function renderProgressBar(pct, width = 24) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${clamped.toFixed(2)}%`;
}

export function formatMarkdownProgress(report) {
  const sign = n => (n > 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`);
  const lines = [];
  lines.push(`### FERRUM Weighted Progress: \`${report.project}\``);
  lines.push("");
  lines.push(
    `**${report.progressBar}** — **${report.totalEarned.toFixed(2)} / ${report.totalWeight.toFixed(2)} pts** ` +
    `*(Turn delta: **${sign(report.turnDeltaPct)}** | Since baseline: **${sign(report.baselineDeltaPct)}**)*`,
  );
  lines.push("");
  lines.push("| Pillar | Earned / Weight | Pillar % | Key Active / Sensor Status |");
  lines.push("| :--- | ---: | ---: | :--- |");
  for (const p of report.pillars) {
    const incomplete = p.items.filter(i => i.status !== "completed");
    const sourceItems = incomplete.length > 0 ? incomplete : p.items;
    const activeNotes = sourceItems
      .slice(0, 2)
      .map(i => `${i.id}: ${i.sensorDetail || `${i.progressPct}%`}`)
      .join("; ") || "All items complete";
    lines.push(`| **${p.id} · ${p.name}** | \`${p.earned.toFixed(2)} / ${p.weight.toFixed(2)}\` | **${p.pct.toFixed(1)}%** | ${activeNotes} |`);
  }

  if (report.nextHighLeverageItems.length > 0) {
    lines.push("");
    lines.push("**Top Remaining Weight Drivers:**");
    for (const item of report.nextHighLeverageItems.slice(0, 5)) {
      const detail = item.sensorDetail ? ` — *${item.sensorDetail}*` : "";
      lines.push(`- **\`${item.id}\` (+${item.remainingWeight.toFixed(2)}% available):** ${item.title} (${item.progressPct}% done)${detail}`);
    }
  }

  if (report.deferredScope.length > 0) {
    lines.push("");
    lines.push(`*Deferred / Excluded from Active Denominator:* ${report.deferredScope.join(" · ")}`);
  }

  return lines.join("\n");
}

export function updatePlanItem(plan, spec) {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new Error(`Invalid --set spec '${spec}'. Expected <itemId>=<status|0..100>`);
  const id = spec.slice(0, eq).trim();
  const val = spec.slice(eq + 1).trim();

  for (const pillar of plan.pillars || []) {
    for (const item of pillar.items || []) {
      if (item.id === id) {
        if (val === "completed" || val === "done") {
          item.status = "completed";
          item.progress = 1;
        } else if (val === "pending") {
          item.status = "pending";
          item.progress = 0;
        } else if (val === "deferred") {
          item.status = "deferred";
        } else {
          const num = Number(val.replace(/%$/, ""));
          if (Number.isNaN(num)) throw new Error(`Invalid progress value '${val}' for ${id}`);
          const frac = num > 1 ? num / 100 : num;
          item.progress = Math.max(0, Math.min(1, frac));
          item.status = item.progress >= 0.9999 ? "completed" : item.progress > 0 ? "in_progress" : "pending";
        }
        return true;
      }
    }
  }
  throw new Error(`Item '${id}' not found in ${PLAN_FILENAME}`);
}

function main(argv = process.argv.slice(2)) {
  let root = process.cwd();
  let init = false;
  let asJson = false;
  let recordTurn = false;
  const updates = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--init") init = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--record") recordTurn = true;
    else if (arg === "--set") updates.push(argv[++i]);
    else if (!arg.startsWith("-")) root = path.resolve(arg);
  }

  const planPath = path.join(root, PLAN_FILENAME);
  let plan;
  if (init || !fs.existsSync(planPath)) {
    plan = buildDefaultPlan(root);
    if (init) {
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
    }
  } else {
    plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  }

  for (const u of updates) {
    updatePlanItem(plan, u);
  }

  const report = evaluatePlan(root, plan);

  if (init || updates.length > 0 || recordTurn) {
    if (recordTurn) {
      plan.lastTurnPct = report.overallPct;
    }
    plan.updatedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", "utf8");
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatMarkdownProgress(report) + "\n");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
