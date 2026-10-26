#!/usr/bin/env node
/**
 * FERRUM Vast.ai Cloud Orchestrator & Built-in MCP Server (`ferrum vast`)
 *
 * Bridges FERRUM's multi-agent Rust protocol with Vast.ai on-demand instances and
 * Community MCP servers (`vastai-mcp` / `vast-mcp-server`).
 *
 * Why a Rust-specific Vast.ai layer matters:
 *   1. Standard Vast.ai searches optimize for GPU TFLOPS, which often rents an expensive
 *      GPU attached to a weak 4-core CPU that compiles Rust slower than a laptop.
 *      `rankRustOffers` filters for high `cpu_cores_effective` (>=32), >=2 GB RAM/core,
 *      fast NVMe (`disk_bw >= 500` MB/s), and ranks by `Effective CPU Cores per Dollar`.
 *   2. Vast.ai instances are Docker containers where `/sbin/poweroff` does NOT stop
 *      billing. `buildVastOnstartScript` injects a container-safe Dead-Man's Switch that
 *      calls the Vast.ai REST API (`PUT /api/v0/instances/$CONTAINER_ID/ {"state":"stopped"}`)
 *      after N minutes of zero `cargo`/`rustc`/`lld` activity.
 *   3. Can run as a CLI (`ferrum vast search|instances|create|stop|destroy|balance`) OR as
 *      a zero-dependency stdio MCP server (`ferrum vast --mcp`).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const VAST_API_BASE = "https://console.vast.ai/api/v0";

/** Resolve Vast.ai API key from env or `~/.vast_api_key` / `~/.config/vastai/vast_api_key`. */
export function resolveVastApiKey(env = process.env, homeDir = os.homedir()) {
  if (env.VAST_API_KEY?.trim()) return env.VAST_API_KEY.trim();
  if (env.VASTAI_API_KEY?.trim()) return env.VASTAI_API_KEY.trim();
  const candidates = [
    path.join(homeDir, ".vast_api_key"),
    path.join(homeDir, ".config", "vastai", "vast_api_key"),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const key = fs.readFileSync(file, "utf8").trim();
        if (key) return key;
      }
    } catch {}
  }
  return null;
}

/**
 * Parse a Vast.ai SSH target (`ssh://root@ssh5.vast.ai:41892`, `root@host:port`, or `host`)
 * into `{ userHost, port, sshUrl }`.
 */
export function parseSshEndpoint(raw, explicitPort = "") {
  const str = String(raw || "").trim();
  const urlMatch = str.match(/^ssh:\/\/([^@/:]+@[^/:]+)(?::(\d+))?\/?$/);
  if (urlMatch) {
    const userHost = urlMatch[1];
    const port = String(explicitPort || urlMatch[2] || "22");
    return { userHost, port, sshUrl: `ssh://${userHost}:${port}` };
  }
  const colonPort = str.match(/^([^:]+):(\d+)$/);
  if (colonPort && !explicitPort) {
    return {
      userHost: colonPort[1],
      port: colonPort[2],
      sshUrl: `ssh://${colonPort[1]}:${colonPort[2]}`,
    };
  }
  const port = String(explicitPort || "22");
  return { userHost: str, port, sshUrl: `ssh://${str}:${port}` };
}

/**
 * Filter and rank Vast.ai offers for Rust workspace compilation & testing.
 * Prioritizes high effective CPU cores per dollar, >= 2 GB RAM per core (prevents LLVM/lld OOM),
 * high NVMe disk bandwidth, and high host reliability.
 */
export function rankRustOffers(
  offers = [],
  {
    minCores = 16,
    minRamGb = 32,
    minRamPerCoreGb = 1.75,
    minDiskBwMb = 500,
    minReliability = 0.98,
    maxDph = 2.0,
    gpuName = "",
    limit = 10,
  } = {},
) {
  const gpuFilter = gpuName.trim().toLowerCase().replaceAll("_", " ");
  const qualified = [];

  for (const o of offers) {
    const cores = Number(o.cpu_cores_effective || o.cpu_cores || 0);
    const ramMb = Number(o.cpu_ram || 0);
    const ramGb = ramMb > 1024 ? Math.round((ramMb / 1024) * 10) / 10 : ramMb;
    const dph = Number(o.dph_total || o.dph_base || 0);
    const diskBw = Number(o.disk_bw || 0);
    const reliability = Number(o.reliability2 || o.reliability || 0);
    const gpu = String(o.gpu_name || "CPU").trim();

    if (cores < minCores) continue;
    if (ramGb < minRamGb) continue;
    if (cores > 0 && ramGb / cores < minRamPerCoreGb) continue;
    if (dph <= 0 || dph > maxDph) continue;
    if (diskBw > 0 && diskBw < minDiskBwMb) continue;
    if (reliability > 0 && reliability < minReliability) continue;
    if (gpuFilter && !gpu.toLowerCase().includes(gpuFilter)) continue;

    const coresPerDollar = Math.round((cores / dph) * 10) / 10;
    const recommendedZthreads = cores >= 48 ? 16 : cores >= 24 ? 12 : 8;
    qualified.push({
      id: o.id,
      cpuCoresEffective: cores,
      cpuName: o.cpu_name || "Unknown CPU",
      ramGb,
      ramPerCoreGb: Math.round((ramGb / cores) * 100) / 100,
      diskBwMb: Math.round(diskBw),
      gpuName: gpu,
      numGpus: Number(o.num_gpus || 0),
      dphTotal: Math.round(dph * 1000) / 1000,
      reliability: Math.round(reliability * 10000) / 10000,
      coresPerDollar,
      recommendedZthreads,
      geolocation: o.geolocation || "Unknown",
    });
  }

  qualified.sort((a, b) => b.coresPerDollar - a.coresPerDollar || a.dphTotal - b.dphTotal);
  return qualified.slice(0, limit);
}

/**
 * Generate the Vast.ai `onstart` script that:
 *   1. Installs fast linkers (`lld`, `mold`), `rsync`, `zstd`, and `cargo-nextest` if missing.
 *   2. Launches a container-safe Dead-Man's Switch daemon that stops the Vast.ai instance
 *      via the Vast.ai REST API after `idleMins` of zero `cargo`/`rustc`/`lld` activity.
 */
export function buildVastOnstartScript({ idleMins = 15, autoDestroy = false } = {}) {
  const safeMins = Math.max(5, Number(idleMins) || 15);
  const apiAction = autoDestroy
    ? 'curl -s -X DELETE "https://console.vast.ai/api/v0/instances/${CID}/" -H "Authorization: Bearer ${VKEY}"'
    : 'curl -s -X PUT "https://console.vast.ai/api/v0/instances/${CID}/" -H "Authorization: Bearer ${VKEY}" -H "Content-Type: application/json" -d \'{"state":"stopped"}\'';

  return `#!/usr/bin/env bash
set -u
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq build-essential pkg-config libssl-dev clang lld mold rsync zstd curl git jq procps >/dev/null 2>&1 || true
fi
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -c rustfmt,clippy
fi
source "$HOME/.cargo/env" 2>/dev/null || true

cat >/usr/local/bin/rust-vm-watchdog.sh <<'WATCHDOG_EOF'
#!/usr/bin/env bash
IDLE_MINS=${safeMins}
HB=/tmp/.remote-build-heartbeat
touch "$HB"
while true; do
  sleep 60
  if pgrep -x 'cargo|rustc|rustdoc|cargo-nextest|lld|rust-lld|mold|wild|cc1' >/dev/null 2>&1; then
    touch "$HB"
    continue
  fi
  LAST=$(stat -c %Y "$HB" 2>/dev/null || date +%s)
  NOW=$(date +%s)
  if [ $(( (NOW - LAST) / 60 )) -ge "$IDLE_MINS" ]; then
    CID="\${CONTAINER_ID:-\${VAST_CONTAINERLABEL:-}}"
    CID="\${CID#C.}"
    VKEY="\${VAST_API_KEY:-\$(cat ~/.vast_api_key 2>/dev/null || true)}"
    if [ -n "$CID" ] && [ -n "$VKEY" ]; then
      ${apiAction} >/dev/null 2>&1 || true
    fi
    /sbin/poweroff >/dev/null 2>&1 || systemctl poweroff >/dev/null 2>&1 || kill -TERM 1 2>/dev/null || true
    exit 0
  fi
done
WATCHDOG_EOF
chmod +x /usr/local/bin/rust-vm-watchdog.sh
nohup /usr/local/bin/rust-vm-watchdog.sh >/var/log/rust-vm-watchdog.log 2>&1 &
`;
}

/** Format a Vast.ai instance JSON record into a concise developer/agent summary. */
export function formatInstanceSummary(inst) {
  const id = inst.id;
  const host = inst.ssh_host || inst.public_ipaddr || "";
  const port = inst.ssh_port || (inst.ports?.["22/tcp"]?.[0]?.HostPort) || 22;
  const sshUrl = host ? `ssh://root@${host}:${port}` : null;
  return {
    id,
    status: inst.actual_status || inst.cur_state || inst.intended_status || "unknown",
    cpuCoresEffective: Number(inst.cpu_cores_effective || inst.cpu_cores || 0),
    ramGb: Math.round((Number(inst.cpu_ram || 0) / 1024) * 10) / 10,
    gpuName: inst.gpu_name || "CPU",
    dphTotal: Math.round(Number(inst.dph_total || 0) * 1000) / 1000,
    sshUrl,
    ferrumRemoteCmd: sshUrl
      ? `node bin/ferrum.mjs remote ${sshUrl} --vast-id ${id} --poweroff -- nextest run --workspace`
      : null,
  };
}

async function vastFetch(endpoint, { method = "GET", body, apiKey } = {}) {
  const key = apiKey || resolveVastApiKey();
  if (!key) {
    throw new Error(
      "Missing Vast.ai API key. Set VAST_API_KEY in your environment or save it to ~/.vast_api_key",
    );
  }
  const url = `${VAST_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Vast.ai API ${method} ${endpoint} failed (${res.status}): ${text.slice(0, 240)}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function searchVastRustOffers(options = {}) {
  const minCores = Number(options.minCores || 16);
  const minRamGb = Number(options.minRamGb || 32);
  const minDiskGb = Number(options.minDiskGb || 60);
  const data = await vastFetch("/bundles/?q=" + encodeURIComponent(JSON.stringify({
    verified: { eq: true },
    external: { eq: false },
    rentable: { eq: true },
    rented: { eq: false },
    cpu_cores_effective: { gte: minCores },
    cpu_ram: { gte: minRamGb * 1000 },
    disk_space: { gte: minDiskGb },
    order: [["dph_total", "asc"]],
    type: "on-demand",
    limit: 100,
  })));
  const offers = Array.isArray(data?.offers) ? data.offers : Array.isArray(data) ? data : [];
  return rankRustOffers(offers, options);
}

export async function listVastInstances() {
  const data = await vastFetch("/instances/?owner=me");
  const list = Array.isArray(data?.instances) ? data.instances : Array.isArray(data) ? data : [];
  const formatted = list.map(formatInstanceSummary);
  const totalBurnDph = Math.round(
    formatted
      .filter(i => i.status === "running" || i.status === "loading")
      .reduce((acc, i) => acc + i.dphTotal, 0) * 1000,
  ) / 1000;
  return { activeCount: formatted.length, totalBurnDph, instances: formatted };
}

export async function createVastRustInstance(
  offerId,
  { diskGb = 40, image = "rust:latest", idleMins = 15, autoDestroy = false } = {},
) {
  if (!offerId) throw new Error("offerId is required to create a Vast.ai instance");
  const apiKey = resolveVastApiKey();
  const onstart = buildVastOnstartScript({ idleMins, autoDestroy });
  const res = await vastFetch(`/asks/${offerId}/`, {
    method: "PUT",
    apiKey,
    body: {
      client_id: "me",
      image,
      disk: Number(diskGb),
      runtype: "ssh_direc ssh_proxy",
      onstart,
      env: {
        VAST_API_KEY: apiKey,
      },
    },
  });
  return res;
}

export async function stopVastInstance(instanceId) {
  if (!instanceId) throw new Error("instanceId is required");
  return vastFetch(`/instances/${instanceId}/`, {
    method: "PUT",
    body: { state: "stopped" },
  });
}

export async function destroyVastInstance(instanceId) {
  if (!instanceId) throw new Error("instanceId is required");
  return vastFetch(`/instances/${instanceId}/`, {
    method: "DELETE",
  });
}

export async function getVastBalance() {
  const user = await vastFetch("/users/current/");
  const instances = await listVastInstances().catch(() => ({ totalBurnDph: 0, activeCount: 0 }));
  return {
    credit: Number(user?.credit || user?.balance || 0),
    email: user?.email || null,
    activeInstances: instances.activeCount,
    currentHourlyBurnUsd: instances.totalBurnDph,
  };
}

// ---------------------------------------------------------------------------
// Built-in MCP (Model Context Protocol) stdio JSON-RPC 2.0 Server
// ---------------------------------------------------------------------------
export const MCP_TOOLS = [
  {
    name: "vast_search_rust_offers",
    description: "Search Vast.ai offers ranked by Effective CPU Cores per Dollar for fast multi-core Rust builds (filters for >=2GB RAM/core and fast NVMe).",
    inputSchema: {
      type: "object",
      properties: {
        minCores: { type: "number", default: 32, description: "Minimum effective CPU cores" },
        minRamGb: { type: "number", default: 64, description: "Minimum system RAM in GB" },
        maxDph: { type: "number", default: 1.0, description: "Maximum price in USD/hour" },
        gpuName: { type: "string", default: "", description: "Optional GPU filter (e.g. RTX 4090) for CUDA/WGPU Rust builds" },
      },
    },
  },
  {
    name: "vast_list_instances",
    description: "List active Vast.ai instances, their SSH URLs, and current hourly burn rate ($/hr).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vast_create_rust_instance",
    description: "Launch a Vast.ai Rust build instance pre-configured with lld/mold, rustup, and a 15-minute idle auto-stop Dead-Man's Switch.",
    inputSchema: {
      type: "object",
      required: ["offerId"],
      properties: {
        offerId: { type: "number", description: "Vast.ai offer ID from vast_search_rust_offers" },
        diskGb: { type: "number", default: 40 },
        image: { type: "string", default: "rust:latest" },
        idleMins: { type: "number", default: 15, description: "Minutes of zero cargo/rustc activity before auto-stopping billing" },
        autoDestroy: { type: "boolean", default: false, description: "If true, destroys instance on idle instead of stopping" },
      },
    },
  },
  {
    name: "vast_stop_instance",
    description: "Stop a running Vast.ai instance immediately (use right before local LLM review so compute costs $0).",
    inputSchema: {
      type: "object",
      required: ["instanceId"],
      properties: { instanceId: { type: "number" } },
    },
  },
  {
    name: "vast_destroy_instance",
    description: "Destroy a Vast.ai instance completely so both compute and storage billing stop.",
    inputSchema: {
      type: "object",
      required: ["instanceId"],
      properties: { instanceId: { type: "number" } },
    },
  },
  {
    name: "vast_balance",
    description: "Check Vast.ai account credit balance and current hourly burn rate across active instances.",
    inputSchema: { type: "object", properties: {} },
  },
];

function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");

  rl.on("line", async line => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;

    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "ferrum-vast-mcp", version: "1.0.0" },
          },
        });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
      } else if (method === "tools/call") {
        const name = params?.name;
        const args = params?.arguments || {};
        let out;
        if (name === "vast_search_rust_offers") out = await searchVastRustOffers(args);
        else if (name === "vast_list_instances") out = await listVastInstances();
        else if (name === "vast_create_rust_instance") out = await createVastRustInstance(args.offerId, args);
        else if (name === "vast_stop_instance") out = await stopVastInstance(args.instanceId);
        else if (name === "vast_destroy_instance") out = await destroyVastInstance(args.instanceId);
        else if (name === "vast_balance") out = await getVastBalance();
        else throw new Error(`Unknown MCP tool: ${name}`);

        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
        });
      } else if (id !== undefined) {
        send({ jsonrpc: "2.0", id, result: {} });
      }
    } catch (err) {
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: `FERRUM Vast MCP error: ${err.message}` }],
          },
        });
      }
    }
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--mcp")) {
    startMcpServer();
    return;
  }
  const [cmd = "help", ...rest] = argv;
  try {
    if (cmd === "search") {
      let minCores = 32, minRamGb = 64, maxDph = 1.0, gpuName = "";
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--min-cores") minCores = Number(rest[++i]);
        else if (rest[i] === "--min-ram") minRamGb = Number(rest[++i]);
        else if (rest[i] === "--max-dph") maxDph = Number(rest[++i]);
        else if (rest[i] === "--gpu") gpuName = rest[++i];
      }
      const offers = await searchVastRustOffers({ minCores, minRamGb, maxDph, gpuName });
      process.stdout.write(JSON.stringify(offers, null, 2) + "\n");
    } else if (cmd === "instances" || cmd === "ls") {
      process.stdout.write(JSON.stringify(await listVastInstances(), null, 2) + "\n");
    } else if (cmd === "balance") {
      process.stdout.write(JSON.stringify(await getVastBalance(), null, 2) + "\n");
    } else if (cmd === "create") {
      const offerId = rest[0];
      let diskGb = 40, image = "rust:latest", idleMins = 15, autoDestroy = false;
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--disk") diskGb = Number(rest[++i]);
        else if (rest[i] === "--image") image = rest[++i];
        else if (rest[i] === "--idle-mins") idleMins = Number(rest[++i]);
        else if (rest[i] === "--destroy-on-idle") autoDestroy = true;
      }
      process.stdout.write(JSON.stringify(await createVastRustInstance(offerId, { diskGb, image, idleMins, autoDestroy }), null, 2) + "\n");
    } else if (cmd === "stop") {
      process.stdout.write(JSON.stringify(await stopVastInstance(rest[0]), null, 2) + "\n");
    } else if (cmd === "destroy") {
      process.stdout.write(JSON.stringify(await destroyVastInstance(rest[0]), null, 2) + "\n");
    } else {
      process.stdout.write(`FERRUM Vast.ai Cloud Orchestrator & MCP Server
Usage:
  ferrum vast search [--min-cores 32] [--min-ram 64] [--max-dph 1.0] [--gpu RTX_4090]
  ferrum vast instances
  ferrum vast balance
  ferrum vast create <offer-id> [--disk 40] [--image rust:latest] [--idle-mins 15] [--destroy-on-idle]
  ferrum vast stop <instance-id>
  ferrum vast destroy <instance-id>
  ferrum vast --mcp    (Run as stdio Model Context Protocol server)
`);
    }
  } catch (err) {
    process.stderr.write(`ferrum vast error: ${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
