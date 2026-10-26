#!/usr/bin/env node
/**
 * FERRUM Cross-Platform Multi-Agent Installer
 * Links the FERRUM Rust Architecture & Fast-Build Skill across:
 *   - Claude Code (~/.claude/skills/weedo-rust-dev-skill)
 *   - OpenAI Codex CLI (~/.codex/skills/weedo-rust-dev-skill)
 *   - Google Antigravity (~/.gemini/config/skills/weedo-rust-dev-skill + plugins/ferrum-rust-suite)
 * Works on Windows (using junctions, no Admin needed), macOS, and Linux.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rustReadiness } from "./rust.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect x="14" y="14" width="100" height="100" rx="22" fill="#18181B" stroke="#F97316" stroke-width="6"/>
  <path d="M38 42H90M38 42V88M38 64H76" stroke="#F97316" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="88" cy="84" r="9" fill="#22C55E"/>
</svg>
`;

/** Safely link `sourceDir` at `targetPath` using a junction on Windows or dir symlink on Unix. */
export function linkDirectory(sourceDir, targetPath, { platform = process.platform, dryRun = false } = {}) {
  const resolvedSource = fs.realpathSync(sourceDir);
  if (dryRun) return { status: "dry-run", source: resolvedSource, target: targetPath };

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let stat = null;
  try { stat = fs.lstatSync(targetPath); } catch {}

  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        if (fs.realpathSync(targetPath) === resolvedSource) {
          return { status: "unchanged", source: resolvedSource, target: targetPath };
        }
      } catch {}
      fs.unlinkSync(targetPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  }

  const linkType = platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(resolvedSource, targetPath, linkType);
  return { status: "linked", source: resolvedSource, target: targetPath, type: linkType };
}

/** Configure Claude Code, Codex CLI, and Antigravity under `homeDir`. */
export function setupAllAgents({
  homeDir = os.homedir(),
  repoRoot = REPO_ROOT,
  platform = process.platform,
  dryRun = false,
} = {}) {
  const rustSkillSource = path.join(repoRoot, "skills", "weedo-rust-dev-skill");
  if (!fs.existsSync(rustSkillSource)) {
    throw Error(`Missing bundled skill directory: ${rustSkillSource}`);
  }

  const links = [
    {
      agent: "claude-code",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".claude", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
    {
      agent: "codex-cli",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".codex", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
    {
      agent: "antigravity",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".gemini", "config", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
  ];

  const results = links.map(entry => ({
    agent: entry.agent,
    name: entry.name,
    ...linkDirectory(entry.source, entry.target, { platform, dryRun }),
  }));

  const agyPluginDir = path.join(homeDir, ".gemini", "config", "plugins", "ferrum-rust-suite");
  const pluginManifest = {
    name: "ferrum-rust-suite",
    displayName: "FERRUM — Fast Multiplatform Rust Agent Protocol",
    version: "1.0.0",
    description: "FERRUM (Flat-DAG, Edge-Isolated, Reflink-Warmed, Ratchet-Guarded, Unified-Deps, Multi-Agent): Golden Protocol for 100k-1M+ LOC Rust architecture, 9 Golden Laws static gate, brownfield Strangler-Fig ratchet, Sentry triage, and fast multiplatform builds.",
    logo: "assets/logo.svg",
    suggestedPrompts: [
      "Scaffold a multiplatform Rust workspace following the FERRUM protocol (Ship/Ready/Out tiers)",
      "Run FERRUM check-rust-arch --plan to X-ray this brownfield Rust codebase and freeze the ratchet",
      "Audit Rust build parallelism, low-RAM settings, and OS linker speed traps",
    ],
  };

  if (!dryRun) {
    fs.mkdirSync(path.join(agyPluginDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(agyPluginDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agyPluginDir, "plugin.json"), JSON.stringify(pluginManifest, null, 2) + "\n");
    fs.writeFileSync(path.join(agyPluginDir, "assets", "logo.svg"), LOGO_SVG);
    linkDirectory(rustSkillSource, path.join(agyPluginDir, "skills", "weedo-rust-dev-skill"), { platform, dryRun });
  }

  return {
    protocol: "FERRUM",
    platform,
    homeDir,
    repoRoot,
    skills: results,
    antigravityPlugin: {
      dir: "ferrum-rust-suite",
      path: agyPluginDir,
      status: dryRun ? "dry-run" : "installed",
    },
    rust: rustReadiness(repoRoot, spawnSync),
  };
}

function main(argv = process.argv.slice(2)) {
  let homeDir = os.homedir();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && argv[i + 1]) homeDir = path.resolve(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  const summary = setupAllAgents({ homeDir, dryRun });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(`setup-all: ${error.message || error}\n`);
    process.exit(2);
  }
}
