import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Pi never auto-scans an extension's own directory for theme files -- it
// only discovers whatever paths a "resources_discover" handler returns
// (see the registration below). Confirmed live: nothing in this file ever
// registered that handler, so none of Herald's theme JSON files -- not
// even the base "herald" theme applied at every session start -- were ever
// actually reachable by name. ctx.ui.setTheme() failures are silent by
// design (no exception, just {success:false}), so this had no visible
// symptom until you deliberately checked whether a theme other than
// whatever Pi's own built-in default looks like was ever really applied.
const _extensionDir = dirname(fileURLToPath(import.meta.url));
const HERALD_THEME_FILES = [
  "herald-theme.json",
  "herald-midnight-theme.json",
  "herald-paper-theme.json",
  "herald-halloween-theme.json",
  "herald-winter-theme.json",
  "herald-valentine-theme.json",
  "herald-pride-theme.json",
];

// Use the IPv4 loopback explicitly. Recent Node releases may resolve
// `localhost` to ::1 while Herald's safe default bind is 127.0.0.1, which
// makes model discovery fail and leaves Pi reporting an unknown provider.
const routerUrl = (process.env.HERALD_URL || "http://127.0.0.1:8790").replace(/\/$/, "");
const routerApiKey = process.env.HERALD_API_KEY;
const project = process.env.HERALD_PROJECT;
const part = process.env.HERALD_PART;
const scopeLabel = project && part ? `${project}/${part}` : "global";

type Json = Record<string, any>;
type OutputLevel = "info" | "success" | "warning" | "error";
interface HeraldCard {
  title: string;
  content: string;
  level: OutputLevel;
  timestamp: number;
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const headers = new Headers(init?.headers);
  if (routerApiKey) headers.set("authorization", `Bearer ${routerApiKey}`);
  const response = await fetch(`${routerUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : body.error;
    throw new Error(detail || `Herald returned HTTP ${response.status}`);
  }
  return body;
}

function post(path: string, body: Json = {}): Promise<any> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const assistantProject = process.env.HERALD_ASSISTANT_PROJECT || "ultimate-assistant";
const assistantPart = process.env.HERALD_ASSISTANT_PART || "assistant";
const assistantBaseUrl = `${routerUrl}/nodes/main/http`;
let _assistantAppToken: string | null = null;
let _activeAssistantConversationId: string | null = null;

async function getAssistantToken(forceRefresh = false): Promise<string> {
  if (_assistantAppToken && !forceRefresh) return _assistantAppToken;
  const headers = new Headers();
  if (routerApiKey) headers.set("authorization", `Bearer ${routerApiKey}`);
  const response = await fetch(`${assistantBaseUrl}/`, { headers });
  if (!response.ok) {
    throw new Error(`Ultimate Assistant main node unreachable (HTTP ${response.status})`);
  }
  const html = await response.text();
  const match = html.match(/name=["']app-token["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+name=["']app-token["']/i);
  if (!match?.[1]) {
    throw new Error("Could not extract app-token from Ultimate Assistant main node");
  }
  _assistantAppToken = match[1];
  return _assistantAppToken;
}

async function assistantRequest(path: string, init?: RequestInit): Promise<any> {
  for (const force of [false, true]) {
    const token = await getAssistantToken(force);
    const headers = new Headers(init?.headers);
    if (routerApiKey) headers.set("authorization", `Bearer ${routerApiKey}`);
    headers.set("x-ultimate-assistant-token", token);
    headers.set("x-assistant-token", token);
    const response = await fetch(`${assistantBaseUrl}${path}`, { ...init, headers });
    if ((response.status === 401 || response.status === 403) && !force) {
      continue;
    }
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!response.ok) {
      const detail = typeof body.detail === "string" ? body.detail : body.error;
      throw new Error(detail || `Ultimate Assistant returned HTTP ${response.status}`);
    }
    return body;
  }
}

function assistantPost(path: string, body: Json = {}, init?: RequestInit): Promise<any> {
  return assistantRequest(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(init?.headers as any) },
    body: JSON.stringify(body),
  });
}

async function assistantChat(
  message: string,
  options: { conversationId?: string; agent?: string; interfaceName?: string; signal?: AbortSignal; onProgress?: (label: string) => void } = {},
): Promise<{ reply: string; model: string; agent: string; conversation_id: string }> {
  const token = await getAssistantToken();
  const headers = new Headers({
    "content-type": "application/json",
    "x-ultimate-assistant-token": token,
    "x-assistant-token": token,
  });
  if (routerApiKey) headers.set("authorization", `Bearer ${routerApiKey}`);
  const payload: Json = {
    message,
    interface: options.interfaceName || "herald-pi",
  };
  if (options.conversationId || _activeAssistantConversationId) {
    payload.conversation_id = options.conversationId || _activeAssistantConversationId;
  }
  if (options.agent && options.agent !== "auto") {
    payload.agent = options.agent;
  }
  const response = await fetch(`${routerUrl}/nodes/main/http/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const errText = await response.text();
    throw new Error(errText || `Ultimate Assistant chat HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let dataLines: string[] = [];
  let completed: any = null;

  const flushFrame = () => {
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    const evt = currentEvent;
    currentEvent = "";
    let parsed: any = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    if (evt === "ack" && parsed?.text) {
      options.onProgress?.(String(parsed.text));
    } else if (evt === "progress" && parsed?.label) {
      options.onProgress?.(String(parsed.label));
    } else if (evt === "conversation" && parsed?.conversation_id) {
      _activeAssistantConversationId = String(parsed.conversation_id);
    } else if (evt === "complete") {
      if (parsed?.conversation_id) _activeAssistantConversationId = String(parsed.conversation_id);
      completed = parsed;
    } else if (evt === "error") {
      throw new Error(typeof parsed === "string" ? parsed : JSON.stringify(parsed));
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line === "") {
        flushFrame();
      }
    }
  }
  if (dataLines.length) flushFrame();
  if (!completed) throw new Error("Ultimate Assistant stream ended without completion");
  return completed;
}

function scopeQuery(): string {
  return project && part
    ? `?project=${encodeURIComponent(project)}&part=${encodeURIComponent(part)}`
    : "";
}

function scopeBody(): Record<string, string> {
  return project && part ? { project, part } : {};
}

function words(value: string): string[] {
  return value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((item) =>
    item.replace(/^("|')|("|')$/g, "")
  ) || [];
}

function boolMark(value: boolean): string { return value ? "●" : "○"; }
function clip(value: unknown, length = 88): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function amount(value: unknown): string {
  return Number(value || 0).toLocaleString();
}

type ApprovalRisk = "SAFE" | "REQUIRES_CONFIRMATION" | "DESTRUCTIVE" | "IRREVERSIBLE";
const approvalEnabled = ["1", "true", "yes"].includes((process.env.HERALD_REQUIRE_APPROVAL || "").trim().toLowerCase());
const capabilityCeiling = ["read-only", "workspace-write", "full-access"].includes(process.env.HERALD_CAPABILITY_CEILING || "")
  ? String(process.env.HERALD_CAPABILITY_CEILING) : "full-access";
const autoCommitOnWrite = !["0", "false", "no", "off"].includes(
  (process.env.HERALD_AUTO_COMMIT_ON_WRITE || "").trim().toLowerCase(),
);

function interactiveToolRisk(toolName: string, input: Json): ApprovalRisk {
  if (["read", "grep", "find", "ls"].includes(toolName)) return "SAFE";
  if (["write", "edit"].includes(toolName)) return "REQUIRES_CONFIRMATION";
  if (toolName !== "bash") return "DESTRUCTIVE";
  const command = String(input.command || "").toLowerCase();
  const irreversible = [
    /\brm\s+-[a-z]*r[a-z]*f\b/, /\brm\s+-[a-z]*f[a-z]*r\b/,
    /\bgit\s+reset\s+--hard\b/, /\bdrop\s+(database|table)\b/,
    /\bformat\s+[a-z]:\b/, /\bdel\s+\/[sf].*\*/,
  ];
  if (irreversible.some((pattern) => pattern.test(command))) return "IRREVERSIBLE";
  const destructive = [
    /\brm\s+-[a-z]*[rf]\b/, /\bgit\s+push\s+.*(?:--force|-f)\b/,
    /\bgit\s+clean\s+-[a-z]*d\b/, /\bdel\b/, /\bremove-item\b/,
    /\btruncate\s+table\b/, /\bdocker\s+system\s+prune\b/,
  ];
  return destructive.some((pattern) => pattern.test(command)) ? "DESTRUCTIVE" : "REQUIRES_CONFIRMATION";
}

function ceilingError(toolName: string): string | null {
  if (capabilityCeiling === "full-access") return null;
  const readOnly = new Set(["read", "grep", "find", "ls"]);
  const workspaceWrite = new Set([...readOnly, "write", "edit"]);
  const allowed = capabilityCeiling === "read-only" ? readOnly : workspaceWrite;
  return allowed.has(toolName) ? null : `${toolName} is not permitted under Herald's ${capabilityCeiling} capability ceiling`;
}

// Raw ANSI SGR color helpers. Command handlers (as opposed to
// registerEntryRenderer/renderCall/renderResult callbacks) don't receive
// pi's `theme` object, so semantic coloring here (quota danger levels,
// headers) uses direct ANSI codes rather than theme.fg. `visibleWidth`
// (from pi-tui) already treats ANSI sequences as zero-width, confirming
// raw ANSI passthrough is a supported rendering path.
const ansi = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// Semantic color for a remaining-quota percentage, matching the danger
// levels that mattered in practice this session (codex-primary hitting 0%
// with no warning): red under 15%, yellow under 50%, green otherwise.
function quotaColor(remainingPercent: number, text: string): string {
  if (remainingPercent < 15) return ansi.red(text);
  if (remainingPercent < 50) return ansi.yellow(text);
  return ansi.green(text);
}

interface TableColumn {
  header: string;
  align?: "left" | "right";
}

// Renders a Rich-style Unicode box-drawing table (matching the visual
// language of `herald usage`'s Python/Rich CLI output) as a plain string,
// so it can flow through the existing single-Text-blob `show()` pipeline.
// Uses `visibleWidth` (from pi-tui, imported above) rather than
// `.length` for column sizing, so ANSI/theme color codes embedded in
// cell text don't throw off alignment.
function renderTable(columns: TableColumn[], rows: string[][], title?: string): string {
  const widths = columns.map((col, i) =>
    Math.max(visibleWidth(col.header), ...rows.map((row) => visibleWidth(row[i] ?? "")))
  );
  const pad = (text: string, width: number, align: "left" | "right" = "left") => {
    const gap = Math.max(0, width - visibleWidth(text));
    return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
  };
  const rule = (left: string, mid: string, right: string, fill: string) =>
    left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right;

  const lines: string[] = [];
  if (title) lines.push(title);
  lines.push(rule("┌", "┬", "┐", "─"));
  lines.push("│ " + columns.map((col, i) => ansi.cyan(ansi.bold(pad(col.header, widths[i], col.align)))).join(" │ ") + " │");
  lines.push(rule("├", "┼", "┤", "─"));
  if (rows.length === 0) {
    lines.push("│ " + pad("(no rows)", widths.reduce((a, w) => a + w + 3, -1)) + " │");
  } else {
    for (const row of rows) {
      lines.push("│ " + columns.map((col, i) => pad(row[i] ?? "", widths[i], col.align)).join(" │ ") + " │");
    }
  }
  lines.push(rule("└", "┴", "┘", "─"));
  return lines.join("\n");
}

function completion(values: string[], prefix: string) {
  const needle = prefix.toLowerCase();
  return values.filter((value) => value.toLowerCase().includes(needle)).map((value) => ({ value, label: value }));
}

function modelTone(name: string): any {
  const value = name.toLowerCase();
  if (value.includes("claude")) return "syntaxKeyword";
  if (value.includes("codex")) return "syntaxFunction";
  if (value.includes("gemini")) return "accent";
  if (value.includes("gpt")) return "warning";
  if (value.includes("g4f") || value.includes("browser")) return "mdLink";
  if (value.includes("local") || value.includes("llama") || value.includes("studio")) return "success";
  return "toolTitle";
}

export default async function heraldExtension(pi: ExtensionAPI) {
  let routerOnline = false;
  let routeLabel = "efficiency";
  let eventStreamAbort: AbortController | null = null;
  const cleanWriteTargets = new Map<string, string>();
  let approvalQueue = Promise.resolve();
  // Set by /schedule watch <name>, cleared by /schedule unwatch or when the
  // watched run completes. consumeEventStream's already-running background
  // SSE listener checks this on every agent.step/schedule.fired/failed
  // event -- no second stream connection needed for a live watch.
  let watchFilter: { scheduleName: string; project?: string; part?: string } | null = null;
  let lastUserInput = "";
  pi.on("input", async (event) => {
    lastUserInput = event.text || "";
    return { action: "continue" as const };
  });
  let modelPayload: Json = { data: [] };
  let policyPayload: Json = { policies: [] };
  try {
    [modelPayload, policyPayload] = await Promise.all([
      request("/v1/models"), request("/routing/policies"),
    ]);
    routerOnline = true;
  } catch {
    // Register the provider with a safe fallback so the shell can still show diagnostics.
  }

  const modelIds = (modelPayload.data || []).map((model: any) => String(model.id));
  const policies = (policyPayload.policies || []) as any[];
  const policyNames = policies.map((policy: any) => String(policy.name));
  // /v1/models tags every entry with backend_type -- use it to split into
  // three genuinely separate categories instead of one flat name list.
  // A "mode" (routing_policy) always allows fallback across whatever it
  // covers. A "group" (pool/capability_pool) substitutes among its own
  // members on failure. A "pin" is one exact backend's own name -- the
  // router refuses to substitute anything else for it, full stop.
  const GROUP_BACKEND_TYPES = new Set(["pool", "capability_pool"]);
  const groupIds = (modelPayload.data || [])
    .filter((model: any) => GROUP_BACKEND_TYPES.has(String(model.backend_type)))
    .map((model: any) => String(model.id));
  const individualBackendIds = (modelPayload.data || [])
    .filter((model: any) => !GROUP_BACKEND_TYPES.has(String(model.backend_type)) && model.backend_type !== "routing_policy")
    .map((model: any) => String(model.id));
  const models = (modelPayload.data || []).map((model: any) => ({
    id: model.id,
    name: `Herald · ${model.id}`,
    reasoning: Boolean(model.capabilities?.reasoning),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_window || 128000,
    maxTokens: model.max_tokens || 16384,
  }));

  pi.registerProvider("herald", {
    baseUrl: `${routerUrl}/v1`,
    apiKey: routerApiKey || "herald-local-router",
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models,
  });

  // Interactive calls are gated in-process, before pi executes the tool. The
  // router endpoint is audit-only; scheduled/headless MCP calls retain the
  // Python gate and its pending-approval HTTP workflow.
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName);
    const input = (event.input || {}) as Json;
    if (autoCommitOnWrite && ["write", "edit"].includes(toolName)) {
      const target = String(input.path || "").trim();
      if (target) {
        const inRepo = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
        const status = inRepo.code === 0
          ? await pi.exec("git", ["status", "--porcelain", "--", target], { cwd: ctx.cwd })
          : null;
        // Never fold a user's pre-existing edits into an automatic checkpoint.
        if (status?.code === 0 && !status.stdout.trim()) cleanWriteTargets.set(event.toolCallId, target);
      }
    }
    const riskTier = interactiveToolRisk(toolName, input);
    const ceilingFailure = ceilingError(toolName);
    let decision = "auto_allowed_gating_off";
    let blockReason: string | null = null;

    if (ceilingFailure) {
      decision = "rejected_ceiling";
      blockReason = ceilingFailure;
    } else if (approvalEnabled && (riskTier === "DESTRUCTIVE" || riskTier === "IRREVERSIBLE")) {
      if (!ctx.hasUI) {
        decision = "blocked_no_ui";
        blockReason = `${riskTier} tool call blocked because no interactive approval UI is available`;
      } else {
        const summary = toolName === "bash" ? String(input.command || "") : JSON.stringify(input);
        const approved = await ctx.ui.confirm(`Approve ${toolName}?`, `${riskTier}\n\n${summary}`);
        decision = approved ? "approved_interactive" : "denied_interactive";
        if (!approved) blockReason = "Blocked by user";
      }
    } else if (approvalEnabled) {
      decision = "auto_allowed";
    }

    try {
      await post("/approvals/audit", {
        tool_name: toolName, args: input, risk_tier: riskTier,
        capability_ceiling: capabilityCeiling, decision,
      });
    } catch {
      // Router loss must not silently weaken a configured ceiling or denial.
    }
    return blockReason ? { block: true, reason: blockReason } : undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const target = cleanWriteTargets.get(event.toolCallId);
    cleanWriteTargets.delete(event.toolCallId);
    if (!target || event.isError) return;

    const changed = await pi.exec("git", ["status", "--porcelain", "--", target], { cwd: ctx.cwd });
    if (changed.code !== 0 || !changed.stdout.trim()) return;
    const added = await pi.exec("git", ["add", "--", target], { cwd: ctx.cwd });
    if (added.code !== 0) return;
    const committed = await pi.exec(
      "git", ["commit", "--only", "-m", `herald: checkpoint ${target}`, "--", target],
      { cwd: ctx.cwd },
    );
    if (ctx.hasUI) {
      if (committed.code === 0) ctx.ui.notify(`Checkpoint committed: ${target}`, "info");
      else ctx.ui.notify(`Could not auto-commit ${target}: ${committed.stderr.trim()}`, "warning");
    }
  });

  function show(title: string, content: string, level: OutputLevel = "info") {
    pi.appendEntry<HeraldCard>("herald-command", {
      title,
      content,
      level,
      timestamp: Date.now(),
    });
  }

  function failure(title: string, error: unknown) {
    show(title, error instanceof Error ? error.message : String(error), "error");
  }

  async function guarded(title: string, action: () => Promise<void>) {
    try { await action(); } catch (error) { failure(title, error); }
  }

  async function handleApproval(event: Json, ctx: any): Promise<void> {
    const payload = event.payload || {};
    const token = String(payload.token || "");
    if (!token) return;
    const tool = String(payload.tool || "unknown tool");
    const risk = String(payload.risk_tier || "approval required");
    const summary = String(payload.summary || "No preview was provided.");
    const approved = await ctx.ui.confirm(
      `Approve ${tool}?`,
      `${risk}\n\n${summary}\n\nApproval token: ${token}`,
    );
    const decision = approved ? "approve" : "deny";
    await post(`/approvals/${encodeURIComponent(token)}/${decision}`);
    ctx.ui.notify(`${tool} ${approved ? "approved and executed" : "denied"}`, approved ? "success" : "warning");
  }

  function handleInlineNotification(event: Json, ctx: any): void {
    const payload = event.payload || {};
    const eventType = String(event.event_type || "");
    let message: string | null = null;
    let level: "info" | "success" | "warning" | "error" = "info";

    if (eventType === "capability.proposal_ready") {
      const sandbox = payload.sandbox_ok ? "passed" : "failed";
      message = `Capability proposal #${payload.proposal_id ?? "?"} ready: risk=${payload.risk_level ?? "?"}, sandbox=${sandbox}`;
      level = payload.sandbox_ok ? "info" : "warning";
    } else if (eventType === "schedule.failed") {
      message = `Schedule failed: ${payload.name || "unnamed"}${payload.error ? ` — ${payload.error}` : ""}`;
      level = "error";
    } else if (eventType === "quota.reset") {
      message = `Quota reset: ${payload.cli || payload.profile || "unknown"}${payload.remaining_percent != null ? ` (${payload.remaining_percent}% remaining)` : ""}`;
      level = "success";
    } else if (eventType === "quota.threshold_crossed") {
      message = `Quota getting low: ${payload.cli || payload.profile || "unknown"}${payload.remaining_percent != null ? ` (${payload.remaining_percent}% remaining)` : ""}`;
      level = "warning";
    } else if (eventType === "backend.circuit_opened") {
      message = `Backend degraded: ${payload.backend || "unknown"}`;
      level = "warning";
    } else if (eventType === "backend.circuit_closed") {
      message = `Backend recovered: ${payload.backend || "unknown"}`;
      level = "success";
    }

    if (message) ctx.ui.notify(message, level);
  }

  async function consumeEventStream(ctx: any, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const headers = routerApiKey ? { authorization: `Bearer ${routerApiKey}` } : undefined;
        const response = await fetch(`${routerUrl}/event-bus/stream`, { signal, headers });
        if (!response.ok || !response.body) throw new Error(`Herald event stream returned HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() || "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (watchFilter && event.event_type === "agent.step"
              && event.payload?.project === watchFilter.project && event.payload?.part === watchFilter.part) {
              const p = event.payload || {};
              const detail = Object.fromEntries(
                Object.entries(p).filter(([k]) => !["project", "part", "kind", "branch_id", "depth"].includes(k))
              );
              show(`Watching · ${watchFilter.scheduleName}`, `${ansi.cyan(p.kind || "?")} ${JSON.stringify(detail)}`, "info");
            } else if (watchFilter && (event.event_type === "schedule.fired" || event.event_type === "schedule.failed")
              && event.payload?.name === watchFilter.scheduleName) {
              const ok = event.event_type === "schedule.fired";
              show(`Watching · ${watchFilter.scheduleName}`,
                `${ok ? "Run complete." : "Run failed."} Use /schedule log ${watchFilter.scheduleName} for the full summary.`,
                ok ? "success" : "error");
              watchFilter = null;
            } else if (event.event_type === "approval.requested") {
              approvalQueue = approvalQueue.then(() => handleApproval(event, ctx))
                .catch((error) => failure("Approval", error));
            } else {
              handleInlineNotification(event, ctx);
            }
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        failure("Herald event stream", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  pi.registerEntryRenderer<HeraldCard>("herald-command", (entry, { expanded }, theme) => {
    const card = entry.data || { title: "Herald", content: "", level: "info", timestamp: Date.now() };
    const color = card.level === "error" ? "error"
      : card.level === "warning" ? "warning"
      : card.level === "success" ? "success" : "accent";
    const heading = theme.fg(color, `◆ ${card.title}`);
    const timestamp = expanded ? `\n${theme.fg("dim", new Date(card.timestamp).toLocaleTimeString())}` : "";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${heading}\n${card.content}${timestamp}`, 0, 0));
    return box;
  });

  // --- LIVE TASK TRACKING & AUTOPILOT CHECKLIST WIDGET ---
  interface TaskItem {
    id: string;
    title: string;
    status: "pending" | "in_progress" | "completed" | "failed";
  }

  interface TaskListPayload {
    tasks: TaskItem[];
    objective?: string;
  }

  pi.registerTool({
    name: "herald_task_track",
    label: "Herald · Task Checklist",
    description: "Create, update, or check off tasks in Herald's live interactive progress checklist.",
    parameters: Type.Object({
      objective: Type.Optional(Type.String({ description: "High-level goal or milestone" })),
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique task identifier (e.g. step_1)" }),
          title: Type.String({ description: "Clear descriptive task name" }),
          status: Type.String({ description: "pending | in_progress | completed | failed" }),
        })
      ),
    }),
    async execute(_id, params: any) {
      const activeTasks = (params.tasks || []) as TaskItem[];
      const completedCount = activeTasks.filter((t) => t.status === "completed").length;
      return {
        content: [{ type: "text", text: `[Checklist Updated: ${completedCount}/${activeTasks.length} Completed]` }],
        details: { tasks: activeTasks, objective: params.objective },
      };
    },
    renderCall(args: any, theme: any) {
      const tasks = args.tasks || [];
      const completed = tasks.filter((t: any) => t.status === "completed").length;
      return new Text(
        theme.fg("accent", theme.bold(`📋 TASK TRACKER [${completed}/${tasks.length}]`)) +
        (args.objective ? theme.fg("muted", ` · ${args.objective}`) : ""),
        0, 0,
      );
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      const details = (result.details || {}) as TaskListPayload;
      const tasks = details.tasks || [];
      const completed = tasks.filter((t) => t.status === "completed").length;
      const lines = [
        theme.fg(completed === tasks.length && tasks.length > 0 ? "success" : "accent",
          theme.bold(`◆ Active Execution Plan [${completed}/${tasks.length} Complete]`)) +
          (details.objective ? theme.fg("muted", ` — ${details.objective}`) : "")
      ];

      for (const t of tasks) {
        let icon = theme.fg("dim", "◻");
        let titleStyle = theme.fg("muted", t.title);
        if (t.status === "completed") {
          icon = theme.fg("success", "✔");
          titleStyle = theme.fg("success", theme.strikethrough(t.title));
        } else if (t.status === "in_progress") {
          icon = theme.fg("warning", "⏳");
          titleStyle = theme.fg("warning", theme.bold(t.title));
        } else if (t.status === "failed") {
          icon = theme.fg("error", "✖");
          titleStyle = theme.fg("error", t.title);
        }
        lines.push(`  ${icon} ${titleStyle}`);
      }

      const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    },
  });

  pi.registerTool({
    name: "herald_delegate",
    label: "Herald · model graph",
    description: "Delegate a task to Herald's bounded recursive and parallel multi-model graph.",
    parameters: Type.Object({
      prompt: Type.String({ description: "A complete, specific delegated task" }),
      model: Type.Optional(Type.String({ description: "Starting Herald model or routing preset" })),
      max_depth: Type.Optional(Type.Number({ minimum: 0, maximum: 8 })),
      max_parallel: Type.Optional(Type.Number({ minimum: 1, maximum: 16 })),
    }),
    async execute(_id, params: any) {
      const result = await post("/v1/chat/completions", {
        model: params.model || "reason",
        messages: [{ role: "user", content: params.prompt }],
        agentic: true,
        max_depth: params.max_depth ?? 3,
        max_parallel: params.max_parallel ?? 4,
        ...scopeBody(),
      });
      return {
        content: [{ type: "text", text: result.choices?.[0]?.message?.content || "" }],
        details: { trace: result.orchestration_trace || [], budget: result.orchestration_budget || {} },
      };
    },
    renderCall(args: any, theme: any) {
      const model = args.model || "reason";
      return new Text(
        `${theme.fg(modelTone(model), theme.bold(`◆ ${model}`))}  ` +
        theme.fg("muted", clip(args.prompt, 96)),
        0, 0,
      );
    },
    renderResult(result: any, { expanded, isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "◇ Herald is coordinating model participants…"), 0, 0);
      const trace = result.details?.trace || [];
      const participants = new Map<string, any>();
      for (const event of trace) {
        const key = event.branch_id || `${event.model}:${event.depth || 0}`;
        const previous = participants.get(key) || {};
        participants.set(key, { ...previous, ...event, final: previous.final || event.final });
      }
      const lines = [theme.fg("success", `◆ Model exchange complete · ${participants.size || 1} participant${participants.size === 1 ? "" : "s"}`)];
      for (const event of participants.values()) {
        const depth = Number(event.depth || 0);
        const model = String(event.model || "router");
        const role = depth === 0 ? "DIRECTOR" : `AGENT ${depth}`;
        const branch = String(event.branch_id || "").slice(0, 6);
        const prefix = depth === 0 ? "┌─" : `${"  ".repeat(Math.min(depth, 5))}└─`;
        lines.push(`${theme.fg("dim", prefix)} ${theme.fg(modelTone(model), theme.bold(model))} ${theme.fg("muted", `${role}${branch ? ` · ${branch}` : ""}`)}`);
        if (expanded) {
          for (const action of event.actions || []) {
            if (!action) continue;
            const target = action.model || action.name || action.kind || "work";
            const state = action.error ? theme.fg("error", "failed") : theme.fg("success", "returned");
            lines.push(`${"  ".repeat(Math.min(depth + 1, 6))}${theme.fg("dim", "↳")} ${theme.fg(modelTone(String(target)), String(target))} ${state}`);
            if (action.result) lines.push(`${"  ".repeat(Math.min(depth + 2, 7))}${theme.fg("dim", clip(action.result, 120))}`);
          }
        }
      }
      if (!expanded && trace.length) lines.push(theme.fg("dim", "Expand the tool row to inspect exchanges and returned summaries."));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // Pi's example uses child pi processes. Herald retains its modes while
  // routing isolated tasks through the router for policy, quota, and failover.
  const subagentRoles: Record<string, string> = {
    scout: "Reconnoiter the codebase. Return concise facts, paths, symbols, and risks; do not modify files.",
    planner: "Produce a concrete implementation plan grounded in the supplied task and context; do not modify files.",
    reviewer: "Review the supplied work for correctness, regressions, security, and missing verification; do not modify files.",
    worker: "Complete the delegated task directly and verify the result. Report changed files and checks.",
  };
  const SubagentTask = Type.Object({
    agent: Type.String({ description: "Role: scout, planner, reviewer, worker, or a custom role" }),
    task: Type.String({ description: "Complete delegated task" }),
    model: Type.Optional(Type.String({ description: "Herald model or routing policy; defaults to auto" })),
  });

  async function runRoutedSubagent(item: any, signal?: AbortSignal): Promise<any> {
    const role = String(item.agent || "worker");
    const instruction = subagentRoles[role] || `Act as the ${role} specialist.`;
    const response = await request("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({
        model: item.model || "auto",
        messages: [
          { role: "system", content: `You are a bounded Herald sub-agent. ${instruction}` },
          { role: "user", content: String(item.task || "") },
        ],
        ...scopeBody(),
      }),
    });
    return { agent: role, model: item.model || "auto", output: String(response.choices?.[0]?.message?.content || "") };
  }

  pi.registerTool({
    name: "herald_subagent",
    label: "Herald · sub-agents",
    description: "Delegate isolated work through Herald routing. Exactly one mode: single (agent+task), parallel (tasks, max 8/4 concurrent), or chain (steps may use {previous}).",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      tasks: Type.Optional(Type.Array(SubagentTask, { maxItems: 8 })),
      chain: Type.Optional(Type.Array(SubagentTask, { maxItems: 8 })),
    }),
    async execute(_id, params: any, signal: AbortSignal | undefined, onUpdate: any) {
      const modes = Number(Boolean(params.agent && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
      if (modes !== 1) throw new Error("Provide exactly one mode: agent+task, tasks, or chain.");
      if (params.agent && params.task) {
        const result = await runRoutedSubagent(params, signal);
        return { content: [{ type: "text", text: result.output }], details: { mode: "single", results: [result] } };
      }
      if (params.chain?.length) {
        const results: any[] = []; let previous = "";
        for (const [index, step] of params.chain.entries()) {
          const result = await runRoutedSubagent({ ...step, task: step.task.replace(/\{previous\}/g, previous) }, signal);
          results.push(result); previous = result.output;
          onUpdate?.({ content: [{ type: "text", text: `Chain: ${index + 1}/${params.chain.length} complete` }], details: { mode: "chain", results } });
        }
        return { content: [{ type: "text", text: previous }], details: { mode: "chain", results } };
      }
      const tasks = params.tasks || [];
      if (tasks.length > 8) throw new Error("Parallel mode accepts at most 8 tasks.");
      const results: any[] = new Array(tasks.length); let next = 0; let done = 0;
      const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
        while (next < tasks.length) {
          const index = next++; results[index] = await runRoutedSubagent(tasks[index], signal); done++;
          onUpdate?.({ content: [{ type: "text", text: `Parallel: ${done}/${tasks.length} complete` }], details: { mode: "parallel", results: results.filter(Boolean) } });
        }
      });
      await Promise.all(workers);
      const text = results.map((result) => `### [${result.agent}] completed\n\n${result.output}`).join("\n\n");
      return { content: [{ type: "text", text }], details: { mode: "parallel", results } };
    },
    renderCall(args: any, theme: any) {
      const mode = args.chain?.length ? `chain · ${args.chain.length}` : args.tasks?.length ? `parallel · ${args.tasks.length}` : args.agent || "single";
      return new Text(`${theme.fg("accent", theme.bold("◆ Herald sub-agents"))}  ${theme.fg("muted", mode)}`, 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", result.content?.[0]?.text || "Sub-agents working…"), 0, 0);
      const details = result.details || {};
      return new Text(theme.fg("success", `◆ ${details.mode || "sub-agent"} complete · ${(details.results || []).length} result(s)`), 0, 0);
    },
  });

  pi.registerTool({
    name: "herald_assistant_agent",
    label: "Ultimate Assistant · agent",
    description: "Run a task through Ultimate Assistant's backend on the main node. Use agent='auto' for full multi-agent dispatch with shared conversation/memory/skills, or name a specialist: companion, operator, builder, researcher, tutor, planner.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "auto (default) or specialist: companion, operator, builder, researcher, tutor, planner" })),
      task: Type.String({ description: "Task or message for Ultimate Assistant" }),
      context: Type.Optional(Type.String({ description: "Optional extra context when running a specialist directly" })),
      deliver: Type.Optional(Type.String({ description: "none (default), conversation, or notify" })),
    }),
    async execute(_id, params: any, signal: AbortSignal | undefined, onUpdate: any) {
      const targetAgent = String(params.agent || "auto").trim().toLowerCase();
      const taskText = String(params.task || "").trim();
      if (!taskText) throw new Error("task is required");
      if (targetAgent === "auto") {
        const res = await assistantChat(taskText, {
          signal,
          onProgress: (label) => onUpdate?.({ content: [{ type: "text", text: label }], details: { agent: "auto", status: label } }),
        });
        return {
          content: [{ type: "text", text: res.reply }],
          details: { agent: res.agent, model: res.model, conversation_id: res.conversation_id },
        };
      }
      const res = await assistantPost("/api/agents/run", {
        agent: targetAgent,
        task: taskText,
        context: String(params.context || ""),
        deliver: String(params.deliver || "none"),
      }, { signal });
      return {
        content: [{ type: "text", text: String(res.reply || "") }],
        details: { agent: res.agent || targetAgent, model: res.model },
      };
    },
    renderCall(args: any, theme: any) {
      const target = args.agent || "auto";
      return new Text(`${theme.fg("accent", theme.bold("◆ Ultimate Assistant"))}  ${theme.fg("muted", `${target} · ${clip(args.task, 60)}`)}`, 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", `◆ ${result.content?.[0]?.text || "Ultimate Assistant working…"}`), 0, 0);
      const details = result.details || {};
      return new Text(theme.fg("success", `◆ Ultimate Assistant [${details.agent || "done"}${details.model ? ` · ${details.model}` : ""}]`), 0, 0);
    },
  });

  const registeredToolNames = new Set<string>();
  const registerScopedTools = (tools: any[], scopeOverride: Record<string, string>) => {
    for (const tool of tools || []) {
      const exposedName = `herald_${String(tool.name).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      if (registeredToolNames.has(exposedName)) continue;
      registeredToolNames.add(exposedName);
      pi.registerTool({
        name: exposedName,
        label: `Herald MCP · ${tool.name}`,
        description: `${tool.description || "Herald registered tool"} [${tool.package || tool.instance}@${tool.version || "unversioned"}]`,
        parameters: Type.Unsafe(tool.input_schema || { type: "object", properties: {} }),
        async execute(_id, params: any) {
          const result = await post("/tools/run", { name: tool.name, arguments: params || {}, ...scopeOverride });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
  };

  try {
    const toolPayload = await request(`/tools${scopeQuery()}`);
    registerScopedTools(toolPayload.tools || [], scopeBody());
    if (!project && !part) {
      try {
        const uaQuery = `?project=${encodeURIComponent(assistantProject)}&part=${encodeURIComponent(assistantPart)}`;
        const uaTools = await request(`/tools${uaQuery}`);
        registerScopedTools(uaTools.tools || [], { project: assistantProject, part: assistantPart });
      } catch {
        // Best-effort: Ultimate Assistant scope is optional if not yet registered on this router
      }
    }
  } catch {
    routerOnline = false;
  }

  async function activateMode(selected: string, ctx: any) {
    const policy = policies.find((item: any) => item.name === selected);
    if (!policy) throw new Error(`Unknown routing mode: ${selected}`);
    const model = ctx.modelRegistry.find("herald", selected);
    if (!model) throw new Error(`Routing mode '${selected}' is not available from the router`);
    if (!await pi.setModel(model)) throw new Error(`Could not activate ${selected}`);
    routeLabel = selected;
    ctx.ui.setStatus("herald-route", `mode ${selected}`);
    ctx.ui.setTitle(`Herald — ${selected} — ${scopeLabel}`);
    const access = policy.free_only
      ? "Free/browser-session and local lanes only"
      : `Allowed lanes: ${(policy.delegate_types || []).join(", ")}`;
    const order = (policy.automatic_order || []).join(" → ");
    show(`Routing mode · ${selected}`, [
      policy.description,
      "",
      access,
      `Preference: ${order || "configured backend priority"}`,
      `Tool catalog: ${policy.compact_tool_catalog ? "compact for lower token use" : "full"}`,
    ].join("\n"), "success");
  }

  function currentHolidayTheme(): string {
    const month = new Date().getMonth() + 1;
    if (month === 2) return "herald-valentine";
    if (month === 6) return "herald-pride";
    if (month === 10) return "herald-halloween";
    if (month === 12) return "herald-winter";
    return "herald";
  }

  const themeNames = ["herald", "herald-midnight", "herald-paper", "herald-halloween", "herald-winter", "herald-valentine", "herald-pride"];
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  const helpText = [
    "MODEL & SCOPE",
    "  /model [MODE]              Select an explained routing behavior",
    "  /model backend [NAME]      Advanced: pin an individual backend",
    "  /scope                     Show the active router and project boundary",
    "",
    "IDENTITY",
    "  /accounts [activate NAME]  Inspect or activate named CLI/API/browser accounts",
    "  /accounts add|lane ...     Register a new account or attach a model lane",
    "  /login [CLI|recheck]       Inspect login state, start reauthentication, or recheck status",
    "  /login code CLI CODE       Complete a device-code login",
    "  /login poll|cancel CLI      Poll or cancel a pending login",
    "  /login provider [NAME]     Advanced: native provider OAuth",
    "  /capture [ACCOUNT|list]    Securely refresh a G4F browser-session account",
    "",
    "TOOLS & AUTOMATION",
    "  /tools [filter]            List scoped MCP and local tools",
    "  /tools run NAME [JSON|k=v] Execute a registered tool directly",
    "  /mcp [show|access|create]   Manage controlled MCP groups and bindings",
    "  /mcp remove|unbind|delete   Remove a tool, a binding, or a whole group",
    "  /integrations              Discover external CLI MCP connections",
    "  /integrations import O N   Import owner/name with secret vaulting",
    "  /connectors [list|add]     List or register external model connectors",
    "  /schedule [list|add|...]   Pick a schedule interactively, or manage directly",
    "  /schedule run|watch NAME   Fire a schedule now, or watch it live",
    "  /flow [list]               List persistent multi-model runs",
    "  /flow resume RUN_ID        Resume an encrypted flow checkpoint",
    "  /memory [list|inspect ID]  Inspect named encrypted agent memories",
    "  /memory reset|delete ID    Clear or permanently delete a memory",
    "  /memory export|import ID P Back up or restore a memory to a JSON file",
    "  /history search QUERY      Search stored prompts and responses",
    "  /capability [list|show]    Review drafted capability proposals",
    "  /capability approve|deny ID Resolve a capability proposal",
    "  /events [topic]            Show sanitized router lifecycle events",
    "  /hooks [add|remove]        Inspect or manage event hooks",
    "",
    "ULTIMATE ASSISTANT & OMARCHY",
    "  /assistant [status|ask|work] Ultimate Assistant status, active jobs, or full chat turn",
    "  /agents [list|run A TASK]  Inspect or run specialist agents (operator, builder, etc.)",
    "  /conversations [list|show] Browse or inspect cross-device Ultimate Assistant threads",
    "  /tasks [list|add|done]     Manage Ultimate Assistant commitments and tasks",
    "  /canvas [list|show|clear]  Inspect, pin, or clear live desktop overlay canvas cards",
    "  /skills [list|recordings]  Inspect learned assistant skills and teach recordings",
    "  /modules [list|enable|...] Manage Ultimate Assistant optional capability modules",
    "  /omarchy [profile|ref|...] Omarchy Linux profile, keybindings, docs, changes & crashes",
    "",
    "SHELL",
    "  /appearance                Themes, holiday colors, syntax, and thinking display",
    "  /status                    Router, auth, quota, G4F, and scope overview",
    "  /usage                     Usage across CLIs, APIs, G4F, and local models",
    "  /usage clis                Show CLI subscription quota and reset details",
    "  /quiet [on|off|toggle]     Show or change event-notification quiet mode",
    "  /dashboard [open|url]      Open the Account Console or show its address",
    "  /update                    Pull latest git updates or upgrade PyPI package",
    "  /new                       Start a clean Herald conversation",
    "  /help                      Show this command center",
    "",
    "Herald session controls include /fork, /tree, /compact, /resume, and /quit.",
  ].join("\n");

  pi.registerCommand("help", {
    description: "Herald command center and slash-command reference",
    handler: async () => show("Herald command center", helpText),
  });
  pi.registerCommand("status", {
    description: "Show router, auth, quota, G4F, and project health",
    handler: async (_args, _ctx) => guarded("Herald status", async () => {
      const [backends, auth, usage, capture] = await Promise.all([
        request("/backends"), request("/auth/status"), request("/usage/summary"),
        request("/capture/kapture"),
      ]);
      const backendRows = backends.backends || backends || [];
      const enabled = backendRows.filter((item: any) => item.enabled).length;
      const healthy = backendRows.filter((item: any) => item.enabled && !item.circuit_open).length;
      const cliRows = auth.clis || [];
      const loggedIn = cliRows.filter((item: any) => item.status === "logged_in").length;
      const lines = [
        `${boolMark(routerOnline)} router     ${routerUrl}`,
        `${boolMark(healthy > 0)} backends   ${healthy}/${enabled} enabled lanes available`,
        `${boolMark(loggedIn > 0)} CLI auth   ${loggedIn}/${cliRows.length} profiles logged in`,
        `${boolMark(Boolean(capture.bridge_reachable))} Kapture    ${capture.bridge_reachable ? "connected" : "offline"}`,
        `◆ route       ${routeLabel}`,
        `◆ scope       ${scopeLabel}`,
        `◆ calls       ${(usage.by_backend || []).reduce((total: number, row: any) => total + Number(row.total_calls || 0), 0)}`,
      ];
      show("Herald status", lines.join("\n"), healthy > 0 ? "success" : "warning");
    }),
  });

  pi.registerCommand("usage", {
    description: "Show high-readability Herald usage, native subscription limits, and cloud capacity (or drill in with backends|clis|free|coverage)",
    getArgumentCompletions: async (prefix) => completion(["overview", "backends", "clis", "free", "coverage"], prefix),
    handler: async (args, ctx) => guarded("Usage", async () => {
      const section = args.trim().toLowerCase();
      const payload = await request("/usage/all?refresh=true");

      if (!section || section === "overview") {
        const totals = payload.totals || {};
        const calls = totals.calls || 0;
        const tin = totals.input_tokens || 0;
        const tout = totals.output_tokens || 0;
        const cost = (totals.known_cost_usd || 0).toFixed(4);

        const formatTokens = (n: number) => {
          if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
          if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
          return `${n}`;
        };
        const progressBar = (pct: number) => {
          const capped = Math.max(0, Math.min(100, Math.round(pct)));
          const filled = Math.round(capped / 10);
          return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + `] ${capped}%`;
        };

        const sections: string[] = [];
        const summaryLine =
          `Total Inferences: ${ansi.bold(String(calls))} | ` +
          `Tokens: ${ansi.cyan(formatTokens(tin))} In -> ${ansi.cyan(formatTokens(tout))} Out | ` +
          `Cost: ${ansi.green(`$${cost}`)}`;
        const innerWidth = visibleWidth(summaryLine);
        sections.push(
          "┌" + "─".repeat(innerWidth + 2) + "┐\n" +
          "│ " + summaryLine + " │\n" +
          "└" + "─".repeat(innerWidth + 2) + "┘"
        );

        // Native Subscription Quotas (Claude, Codex, Antigravity) -- payload
        // field is `cli_sessions` (see cli_usage.py's all_usage()), not
        // `cli_subscriptions` -- a prior version of this handler read the
        // wrong field name here and the section silently vanished.
        const cliSessions = payload.cli_sessions || [];
        const okSessions = cliSessions.filter((s: any) => s.status === "ok");
        const quotaRows: string[][] = [];
        for (const sub of okSessions) {
          for (const lim of sub.limits || []) {
            const rem = lim.remaining_percent ?? 0;
            const resets = lim.resets_at
              ? new Date(typeof lim.resets_at === "number" ? lim.resets_at * 1000 : lim.resets_at).toLocaleString()
              : "unknown";
            quotaRows.push([sub.cli, sub.plan_type || "-", lim.name, quotaColor(rem, progressBar(rem)), resets]);
          }
        }
        if (quotaRows.length > 0) {
          sections.push(renderTable(
            [
              { header: "Subscription Profile" }, { header: "Plan" }, { header: "Window" },
              { header: "Quota Remaining", align: "right" }, { header: "Resets At" },
            ],
            quotaRows,
            "\n◆ Native Subscription Quotas (Claude, Codex, Antigravity)",
          ));
        }

        const quotas = payload.quotas || [];
        if (quotas.length > 0) {
          const freeRows = quotas.map((q: any) => {
            const rem = q.remaining_percent ?? 100;
            const used = `${q.used_count || 0} ${q.unit || ""}`.trim();
            return [q.provider, q.tier, quotaColor(rem, progressBar(rem)), used, q.resets || "-"];
          });
          sections.push(renderTable(
            [
              { header: "Provider" }, { header: "Tier" }, { header: "Remaining", align: "right" },
              { header: "Used" }, { header: "Resets" },
            ],
            freeRows,
            "\n◆ Free Cloud & Web API Balances",
          ));
        }

        sections.push("\nUse /usage backends, /usage clis, /usage free, or /usage coverage for detail.");
        show("Herald Usage & Capacity", sections.join("\n"), "info");
        return;
      }
      if (section === "backends") {
        const rows = (payload.backends || []).map((row: any) => {
          const calls = `${amount(row.successful_calls)}/${amount(row.total_calls)}`;
          const tokens = row.input_tokens == null && row.output_tokens == null ? "—" : `${amount(row.input_tokens)} → ${amount(row.output_tokens)}`;
          const cost = row.cost_usd == null ? "$—" : `$${Number(row.cost_usd).toFixed(4)}`;
          const status = row.circuit_open ? ansi.red("Circuit open") : row.enabled ? ansi.green("Active") : ansi.dim("Off");
          return [row.name, row.type || "-", row.pool || "-", calls, tokens, cost, status];
        });
        show("Usage · backends", renderTable(
          [
            { header: "Backend" }, { header: "Type" }, { header: "Pool" },
            { header: "Calls", align: "right" }, { header: "Tokens", align: "right" },
            { header: "Cost", align: "right" }, { header: "Status" },
          ],
          rows,
        ), "info");
        return;
      }
      if (section === "clis") {
        const rows = (payload.cli_sessions || []).map((row: any) => {
          if (row.status !== "ok") return `${boolMark(false)} ${row.cli}\n  ${row.detail || row.status}`;
          const usage = row.usage || {};
          const limits = (row.limits || []).map((limit: any) => {
            const reset = limit.resets_at
              ? new Date(typeof limit.resets_at === "number" ? limit.resets_at * 1000 : limit.resets_at).toLocaleString()
              : "unknown reset";
            return `  ${limit.name}: ${limit.used_percent}% used · ${limit.remaining_percent}% left · resets ${reset}`;
          });
          const tokens = Object.keys(usage).length
            ? `  local tokens: ${amount(usage.input_tokens)} in · ${amount(usage.output_tokens)} out · ${amount(usage.cache_read_input_tokens)} cache read`
            : "";
          return [`${boolMark(true)} ${row.cli} (${row.plan_type || "plan unknown"})`, ...limits, tokens].filter(Boolean).join("\n");
        });
        show("Usage · CLI subscriptions", rows.join("\n") || "No CLI usage sources are available");
        return;
      }
      if (section === "free") {
        const rows = (payload.browser_sessions || []).map((row: any) =>
          `${boolMark(!row.consecutive_failures)} ${row.backend_name.padEnd(22)} ${amount(row.total_calls)} calls · ${amount(row.consecutive_failures)} consecutive failures`
        );
        show("Usage · G4F & browser sessions", rows.join("\n") || "No browser-session calls have been recorded");
        return;
      }
      if (section === "coverage") {
        show("Usage · coverage", (payload.coverage || []).map((line: string) => `• ${line}`).join("\n"));
        return;
      }
      throw new Error("Usage: /usage [overview|backends|clis|free|coverage]");
    }),
  });

  pi.registerCommand("schedule", {
    description: "List and manage Herald cron and event schedules",
    getArgumentCompletions: async (prefix) => completion(["list", "add", "remove", "enable", "disable", "log", "watch", "unwatch", "run"], prefix),
    handler: async (args, ctx) => guarded("Schedules", async () => {
      const tokens = words(args);
      const action = (tokens.shift() || "list").toLowerCase();
      if (action === "list") {
        const wantTable = tokens.includes("--table");
        const payload = await request("/schedules");
        const schedules = payload.schedules || [];
        const rowOf = (item: any) => {
          const trigger = item.trigger_type === "cron"
            ? `cron ${item.cron_expression || "-"}`
            : `event ${item.event_type || "-"}`;
          const target = item.action_type === "agentic"
            ? `${item.project || "-"}/${item.part || "-"}: ${clip(item.prompt, 48)}`
            : clip(item.flow_spec_json || item.action_type, 56);
          const enabled = item.enabled ? ansi.green("yes") : ansi.dim("no");
          const last = item.last_status
            ? `${item.last_status}${item.last_fired_at ? ` @ ${new Date(item.last_fired_at).toLocaleString()}` : ""}`
            : "never run";
          return [String(item.name), trigger, target, enabled, last];
        };
        if (wantTable || !ctx?.ui?.select) {
          show("Herald schedules", renderTable(
            [
              { header: "Name" }, { header: "Trigger" }, { header: "Action" },
              { header: "Enabled" }, { header: "Last status" },
            ],
            schedules.map(rowOf),
          ));
          return;
        }
        if (schedules.length === 0) {
          show("Herald schedules", "No schedules configured yet. Use /schedule add.");
          return;
        }
        const labels = schedules.map((item: any) => {
          const state = item.enabled ? ansi.green("●") : ansi.dim("○");
          const last = item.last_status === "error" ? ansi.red(" [last run failed]") : "";
          return `${state} ${item.name}${last}`;
        });
        const pick = await ctx.ui.select("Herald schedules — pick one to view", [...labels, "Show as table"]);
        if (!pick) return;
        if (pick === "Show as table") {
          show("Herald schedules", renderTable(
            [
              { header: "Name" }, { header: "Trigger" }, { header: "Action" },
              { header: "Enabled" }, { header: "Last status" },
            ],
            schedules.map(rowOf),
          ));
          return;
        }
        const target = schedules[labels.indexOf(pick)];
        if (!target) return;

        const detailLines = rowOf(target);
        show(`Schedule · ${target.name}`, [
          `Trigger: ${detailLines[1]}`,
          `Action: ${detailLines[2]}`,
          `Enabled: ${target.enabled ? "yes" : "no"}`,
          `Last status: ${detailLines[4]}`,
          target.model ? `Model: ${target.model}` : null,
        ].filter(Boolean).join("\n"));

        const nextAction = await ctx.ui.select(`${target.name} — what next?`, [
          "View run log",
          "View run log with trace",
          "Watch live",
          target.enabled ? "Disable" : "Enable",
          "Run now",
          "Remove",
          "Nothing, just looking",
        ]);
        if (!nextAction || nextAction === "Nothing, just looking") return;

        if (nextAction === "Watch live") {
          watchFilter = { scheduleName: target.name, project: target.project, part: target.part };
          show(`Watching · ${target.name}`, "Live steps (model delegation, tool calls) will appear here as this schedule runs. Use /schedule unwatch to stop.", "info");
          return;
        }
        if (nextAction === "Run now") {
          const result = await post(`/schedules/${encodeURIComponent(target.name)}/run`, {});
          show("Schedule fired", `${result.name || target.name}: ${result.status || "firing"}`, "success");
          return;
        }
        if (nextAction === "Remove") {
          const sure = await ctx.ui.confirm(`Remove schedule '${target.name}'?`, "This cannot be undone.");
          if (!sure) return;
          await request(`/schedules/${encodeURIComponent(target.name)}`, { method: "DELETE" });
          show("Schedule removed", target.name, "success");
          return;
        }
        if (nextAction === "Disable" || nextAction === "Enable") {
          const result = await post(`/schedules/${encodeURIComponent(target.name)}/${nextAction.toLowerCase()}`);
          show("Schedule updated", `${result.name || target.name}: ${result.enabled ? "enabled" : "disabled"}`, "success");
          return;
        }

        // View run log / View run log with trace: reuse /schedule log's rendering.
        const showTrace = nextAction === "View run log with trace";
        const logPayload = await request(`/schedules/${encodeURIComponent(target.name)}/runs?limit=20`);
        const runs = logPayload.runs || [];
        if (runs.length === 0) {
          show(`Schedule log · ${target.name}`, "No runs recorded yet.");
          return;
        }
        const renderStep = (step: any): string => {
          if (step.kind === "tool") {
            const ok = step.ok ?? step.success;
            const mark = ok ? ansi.green("✓") : ansi.red("✗");
            return `    ${mark} tool ${ansi.bold(step.name || "?")}(${JSON.stringify(step.arguments || {})})`;
          }
          const depth = Number(step.depth || 0);
          const indent = "  ".repeat(depth + 1);
          const tag = step.final ? ansi.dim(" (final)") : "";
          return `${indent}${ansi.cyan(step.model || "?")} branch=${step.branch_id ?? "-"} depth=${depth}${tag}`;
        };
        const blocks = runs.map((run: any) => {
          const icon = run.status === "ok" ? ansi.green("OK") : ansi.red("FAILED");
          const when = new Date(run.fired_at).toLocaleString();
          const rawSummary = String(run.summary || "").trim();
          const summary = rawSummary
            ? (rawSummary.length > 800 ? `${rawSummary.slice(0, 800)}\n  ...(truncated)` : rawSummary)
            : "(no summary)";
          let block = `${ansi.bold(when)} ${icon}\n  ${summary}`;
          if (showTrace) {
            const trace = run.trace || [];
            block += trace.length > 0
              ? `\n  ${ansi.dim(`-- ${trace.length} orchestration step(s) --`)}\n` + trace.map(renderStep).join("\n")
              : `\n  ${ansi.dim("(no trace recorded for this run)")}`;
          }
          return block;
        });
        show(`Schedule log · ${target.name}`, blocks.join("\n\n"));
        return;
      }

      if (action === "run") {
        const name = tokens.shift();
        if (!name || tokens.length) throw new Error("Usage: /schedule run <name>");
        const result = await post(`/schedules/${encodeURIComponent(name)}/run`, {});
        show("Schedule fired", `${result.name || name}: ${result.status || "firing"}`, "success");
        return;
      }

      if (["remove", "enable", "disable"].includes(action)) {
        const name = tokens.shift();
        if (!name || tokens.length) throw new Error(`Usage: /schedule ${action} <name>`);
        const path = `/schedules/${encodeURIComponent(name)}`;
        const result = action === "remove"
          ? await request(path, { method: "DELETE" })
          : await post(`${path}/${action}`);
        show("Schedule updated", `${result.name || name}: ${result.status || (result.enabled ? "enabled" : "disabled")}`, "success");
        return;
      }

      if (action === "add") {
        const name = tokens.shift();
        if (!name) throw new Error("Usage: /schedule add <name> (--cron \"...\"|--on-event TYPE) --project P --part PT --prompt \"...\"");
        const flags: Record<string, string> = {};
        while (tokens.length) {
          const flag = tokens.shift() || "";
          if (!["--cron", "--on-event", "--project", "--part", "--prompt", "--model"].includes(flag)) {
            throw new Error(`Unknown schedule option '${flag}'`);
          }
          const value = tokens.shift();
          if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
          flags[flag] = value;
        }
        if (Boolean(flags["--cron"]) === Boolean(flags["--on-event"])) {
          throw new Error("Provide exactly one of --cron or --on-event");
        }
        if (!flags["--project"] || !flags["--part"] || !flags["--prompt"]) {
          throw new Error("--project, --part, and --prompt are all required");
        }
        const result = await post("/schedules", {
          name,
          trigger_type: flags["--cron"] ? "cron" : "event",
          cron_expression: flags["--cron"] || null,
          event_type: flags["--on-event"] || null,
          action_type: "agentic",
          project: flags["--project"],
          part: flags["--part"],
          prompt: flags["--prompt"],
          model: flags["--model"] || null,
        });
        const modelNote = flags["--model"] ? `, model ${flags["--model"]}` : "";
        show("Schedule created", `${result.name || name} (${flags["--cron"] ? `cron ${flags["--cron"]}` : `event ${flags["--on-event"]}`}${modelNote})`, "success");
        return;
      }

      if (action === "watch") {
        const name = tokens.shift();
        if (!name) throw new Error("Usage: /schedule watch <name>");
        const payload = await request("/schedules");
        const target = (payload.schedules || []).find((s: any) => s.name === name);
        if (!target) throw new Error(`No schedule named '${name}'`);
        watchFilter = { scheduleName: name, project: target.project, part: target.part };
        show(`Watching · ${name}`, `Live steps (model delegation, tool calls) will appear here as this schedule runs. Use /schedule unwatch to stop.`, "info");
        return;
      }

      if (action === "unwatch") {
        watchFilter = null;
        show("Schedule watch", "Stopped watching.");
        return;
      }

      if (action === "log") {
        // /schedule log <name> [--trace] -- --trace shows the underlying
        // per-model/per-tool-call orchestration steps for agentic runs
        // (which backend handled it, what tools it called, in what order),
        // not just the final text summary.
        const showTrace = tokens.includes("--trace");
        const name = tokens.filter((t) => t !== "--trace").shift();
        if (!name) throw new Error("Usage: /schedule log <name> [--trace]");
        const payload = await request(`/schedules/${encodeURIComponent(name)}/runs?limit=20`);
        const runs = payload.runs || [];
        if (runs.length === 0) {
          show(`Schedule log · ${name}`, "No runs recorded yet.");
          return;
        }
        const renderStep = (step: any): string => {
          if (step.kind === "tool") {
            const ok = step.ok ?? step.success;
            const mark = ok ? ansi.green("✓") : ansi.red("✗");
            return `    ${mark} tool ${ansi.bold(step.name || "?")}(${JSON.stringify(step.arguments || {})})`;
          }
          const depth = Number(step.depth || 0);
          const indent = "  ".repeat(depth + 1);
          const tag = step.final ? ansi.dim(" (final)") : "";
          return `${indent}${ansi.cyan(step.model || "?")} branch=${step.branch_id ?? "-"} depth=${depth}${tag}`;
        };
        const blocks = runs.map((run: any) => {
          const icon = run.status === "ok" ? ansi.green("OK") : ansi.red("FAILED");
          const when = new Date(run.fired_at).toLocaleString();
          const rawSummary = String(run.summary || "").trim();
          const summary = rawSummary
            ? (rawSummary.length > 800 ? `${rawSummary.slice(0, 800)}\n  ...(truncated)` : rawSummary)
            : "(no summary)";
          let block = `${ansi.bold(when)} ${icon}\n  ${summary}`;
          if (showTrace) {
            const trace = run.trace || [];
            block += trace.length > 0
              ? `\n  ${ansi.dim(`-- ${trace.length} orchestration step(s) --`)}\n` + trace.map(renderStep).join("\n")
              : `\n  ${ansi.dim("(no trace recorded for this run)")}`;
          }
          return block;
        });
        show(`Schedule log · ${name}`, blocks.join("\n\n"));
        return;
      }

      throw new Error("Usage: /schedule [list|add|remove|enable|disable|run|log|watch|unwatch]");
    }),
  });

  pi.registerCommand("history", {
    description: "Search stored prompts and responses across agent sessions",
    getArgumentCompletions: async (prefix) => completion(["search"], prefix),
    handler: async (args) => guarded("History", async () => {
      const tokens = words(args);
      const action = (tokens.shift() || "").toLowerCase();
      if (action !== "search") {
        throw new Error("Usage: /history search <query> [--project P] [--part PT] [--since ISO] [--until ISO] [--limit N]");
      }

      const queryWords: string[] = [];
      while (tokens.length && !tokens[0].startsWith("--")) queryWords.push(tokens.shift() || "");
      const query = queryWords.join(" ").trim();
      if (!query) throw new Error("/history search requires a query");

      const flags: Record<string, string> = {};
      while (tokens.length) {
        const flag = tokens.shift() || "";
        if (!["--project", "--part", "--since", "--until", "--limit"].includes(flag)) {
          throw new Error(`Unknown history option '${flag}'`);
        }
        const value = tokens.shift();
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        flags[flag] = value;
      }

      const limit = flags["--limit"] || "20";
      if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
        throw new Error("--limit must be an integer from 1 to 100");
      }
      const params = new URLSearchParams({ query, limit });
      for (const [flag, name] of [["--project", "project"], ["--part", "part"], ["--since", "since"], ["--until", "until"]]) {
        if (flags[flag]) params.set(name, flags[flag]);
      }
      const payload = await request(`/agent-sessions/search?${params.toString()}`);
      const rows = (payload.results || []).map((item: any) => [
        String(item.session_name || item.session_id || "-").slice(0, 24),
        String(Number(item.turn_index || 0) + 1),
        `${item.project || "-"}/${item.part || "-"}`,
        clip(item.input, 60),
        clip(item.output, 60),
      ]);
      show(`Session history matches for '${query}'`, renderTable(
        [
          { header: "Session" }, { header: "Turn", align: "right" }, { header: "Scope" },
          { header: "Input" }, { header: "Output preview" },
        ],
        rows,
      ));
    }),
  });

  pi.registerCommand("capability", {
    description: "Review Herald's pending self-drafted capability proposals",
    getArgumentCompletions: async (prefix) => completion(["list", "show", "approve", "deny"], prefix),
    handler: async (args, ctx) => guarded("Capabilities", async () => {
      const tokens = words(args);
      const action = (tokens.shift() || "list").toLowerCase();

      if (action === "list") {
        const wantTable = tokens.includes("--table");
        const payload = await request("/capabilities/proposals");
        const proposals = payload.proposals || [];
        const rowOf = (proposal: any) => [
          String(proposal.id),
          String(proposal.gap_type || "-"),
          String(proposal.risk_level || "-") === "LOW"
            ? ansi.green("LOW")
            : ["HIGH", "CRITICAL"].includes(String(proposal.risk_level || ""))
              ? ansi.red(String(proposal.risk_level))
              : ansi.yellow(String(proposal.risk_level || "-")),
          proposal.created_at ? new Date(proposal.created_at).toLocaleString() : "-",
        ];
        if (wantTable || !ctx?.ui?.select) {
          show("Pending capability proposals", renderTable(
            [
              { header: "ID", align: "right" }, { header: "Gap type" },
              { header: "Risk tier" }, { header: "Requested at" },
            ],
            proposals.map(rowOf),
          ));
          return;
        }
        if (proposals.length === 0) {
          show("Pending capability proposals", "No proposals pending.");
          return;
        }
        const labels = proposals.map((p: any) => `#${p.id} · ${p.gap_type || "-"} · ${p.risk_level || "-"}`);
        const pick = await ctx.ui.select("Capability proposals — pick one to view", [...labels, "Show as table"]);
        if (!pick) return;
        if (pick === "Show as table") {
          show("Pending capability proposals", renderTable(
            [
              { header: "ID", align: "right" }, { header: "Gap type" },
              { header: "Risk tier" }, { header: "Requested at" },
            ],
            proposals.map(rowOf),
          ));
          return;
        }
        const target = proposals[labels.indexOf(pick)];
        if (!target) return;
        const proposal = await request(`/capabilities/proposals/${target.id}`);
        show(
          `Capability proposal #${proposal.id}`,
          [
            `Status: ${proposal.status || "-"}`,
            `Gap: ${proposal.gap_type || "-"}`,
            `Details: ${proposal.gap_details || "-"}`,
            `Risk: ${proposal.risk_level || "-"}`,
            `Risk findings:\n${proposal.risk_findings || "(none)"}`,
            `Sandbox: ${proposal.sandbox_ok ? "passed" : "failed"}`,
            `Sandbox output:\n${proposal.sandbox_output || "(none)"}`,
            `Drafted source:\n${proposal.draft_source || "(none)"}`,
          ].join("\n\n"),
          proposal.sandbox_ok ? "info" : "warning",
        );
        const nextAction = await ctx.ui.select(`Proposal #${proposal.id} — what next?`, ["Approve", "Deny", "Nothing, just looking"]);
        if (nextAction === "Approve") {
          const result = await post(`/capabilities/proposals/${proposal.id}/approve`);
          show(
            "Capability proposal approved · manual review required",
            `${result.note || "This proposal was not auto-deployed."}\n\n${result.draft_source || "(no drafted source)"}`,
            "warning",
          );
        } else if (nextAction === "Deny") {
          const result = await post(`/capabilities/proposals/${proposal.id}/deny`);
          show("Capability proposal denied", `Proposal #${result.id || proposal.id} was denied.`, "success");
        }
        return;
      }

      if (!["show", "approve", "deny"].includes(action)) {
        throw new Error("Usage: /capability [list|show <id>|approve <id>|deny <id>]");
      }
      const id = tokens.shift();
      if (!id || !/^\d+$/.test(id) || tokens.length) {
        throw new Error(`Usage: /capability ${action} <id>`);
      }

      if (action === "deny") {
        const result = await post(`/capabilities/proposals/${id}/deny`);
        show("Capability proposal denied", `Proposal #${result.id || id} was denied.`, "success");
        return;
      }

      if (action === "approve") {
        const result = await post(`/capabilities/proposals/${id}/approve`);
        show(
          "Capability proposal approved · manual review required",
          `${result.note || "This proposal was not auto-deployed."}\n\n${result.draft_source || "(no drafted source)"}`,
          "warning",
        );
        return;
      }

      const proposal = await request(`/capabilities/proposals/${id}`);
      show(
        `Capability proposal #${proposal.id}`,
        [
          `Status: ${proposal.status || "-"}`,
          `Gap: ${proposal.gap_type || "-"}`,
          `Details: ${proposal.gap_details || "-"}`,
          `Risk: ${proposal.risk_level || "-"}`,
          `Risk findings:\n${proposal.risk_findings || "(none)"}`,
          `Sandbox: ${proposal.sandbox_ok ? "passed" : "failed"}`,
          `Sandbox output:\n${proposal.sandbox_output || "(none)"}`,
          `Drafted source:\n${proposal.draft_source || "(none)"}`,
        ].join("\n\n"),
        proposal.sandbox_ok ? "info" : "warning",
      );
    }),
  });

  pi.registerCommand("connectors", {
    description: "List or register external model connectors",
    getArgumentCompletions: async (prefix) => completion(["list", "add"], prefix),
    handler: async (args, ctx) => guarded("Connectors", async () => {
      const tokens = words(args);
      const action = (tokens.shift() || "list").toLowerCase();

      if (action === "list") {
        const wantTable = tokens.includes("--table");
        // Connector registrations become normal router backends. /backends is
        // the existing read endpoint and redacts credential-like config keys.
        const payload = await request("/backends");
        const connectors = (payload.backends || []).filter((item: any) => item.config?.base_url);
        const rowOf = (item: any) => [
          String(item.name || "-"),
          String(item.config?.runtime || item.backend_type || "-"),
          clip(item.config?.base_url, 52),
          String(item.pool_name || "-"),
          Object.entries(item.capabilities || {}).filter(([, enabled]) => enabled === true).map(([tag]) => tag).join(", ") || "-",
          item.enabled ? ansi.green("yes") : ansi.dim("no"),
        ];
        if (wantTable || !ctx?.ui?.select || connectors.length === 0) {
          show("Registered connectors", renderTable(
            [
              { header: "Name" }, { header: "Type" }, { header: "Base URL" },
              { header: "Pool" }, { header: "Capabilities" }, { header: "Enabled" },
            ],
            connectors.map(rowOf),
          ));
          return;
        }
        const labels = connectors.map((item: any) => `${item.enabled ? ansi.green("●") : ansi.dim("○")} ${item.name} — ${item.config?.runtime || item.backend_type || "-"}`);
        const pick = await ctx.ui.select("Registered connectors — pick one", [...labels, "Show as table"]);
        if (!pick) return;
        if (pick === "Show as table") {
          show("Registered connectors", renderTable(
            [
              { header: "Name" }, { header: "Type" }, { header: "Base URL" },
              { header: "Pool" }, { header: "Capabilities" }, { header: "Enabled" },
            ],
            connectors.map(rowOf),
          ));
          return;
        }
        const target = connectors[labels.indexOf(pick)];
        if (!target) return;
        const row = rowOf(target);
        show(`Connector · ${target.name}`, [
          `Type: ${row[1]}`, `Base URL: ${row[2]}`, `Pool: ${row[3]}`,
          `Capabilities: ${row[4]}`, `Enabled: ${row[5]}`,
        ].join("\n"));
        const nextAction = await ctx.ui.select(`${target.name} — what next?`, ["Remove", "Nothing, just looking"]);
        if (nextAction === "Remove") {
          const sure = await ctx.ui.confirm(`Remove connector '${target.name}'?`, "This cannot be undone.");
          if (!sure) return;
          await request(`/backends/${encodeURIComponent(target.name)}`, { method: "DELETE" });
          show("Connector removed", target.name, "success");
        }
        return;
      }

      if (action !== "add") {
        throw new Error("Usage: /connectors [list|add <name> --type TYPE --base-url URL [--auth ENV_VAR] [--capabilities TAG,TAG]]");
      }
      const name = tokens.shift();
      if (!name) throw new Error("/connectors add requires a name");
      const flags: Record<string, string> = {};
      while (tokens.length) {
        const flag = tokens.shift() || "";
        if (!["--type", "--base-url", "--auth", "--capabilities"].includes(flag)) {
          throw new Error(`Unknown connector option '${flag}'`);
        }
        const value = tokens.shift();
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        flags[flag] = value;
      }
      if (!flags["--type"] || !flags["--base-url"]) {
        throw new Error("--type and --base-url are required");
      }
      const result = await post("/connectors", {
        name,
        type: flags["--type"],
        base_url: flags["--base-url"],
        auth: flags["--auth"] || "none",
        capability_tags: (flags["--capabilities"] || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      const registered = result.registered || (result.backend ? [result.backend] : []);
      show(
        "Connector registered",
        `${result.name || name}: ${result.status || "registered"}${registered.length ? `\nBackends: ${registered.join(", ")}` : ""}`,
        "success",
      );
    }),
  });

  pi.registerCommand("quiet", {
    description: "Show or toggle Herald event-bus quiet mode",
    getArgumentCompletions: async (prefix) => completion(["on", "off", "toggle"], prefix),
    handler: async (args, ctx) => guarded("Quiet mode", async () => {
      const tokens = words(args);
      let action = (tokens.shift() || "").toLowerCase();
      if (tokens.length || (action && !["status", "on", "off", "toggle"].includes(action))) {
        throw new Error("Usage: /quiet [on|off|toggle]");
      }
      if (!action) {
        const currentNow = await request("/event-bus/quiet-mode");
        const enabledNow = Boolean(currentNow.quiet_mode);
        const labels = [
          `Status only (currently ${enabledNow ? "ON" : "OFF"}, no change)`,
          "Turn ON", "Turn OFF", "Toggle",
        ];
        const choice = await ctx.ui.select("Quiet mode", labels);
        if (!choice) return;
        action = choice.startsWith("Status") ? "status" : choice.toLowerCase();
      }

      const current = await request("/event-bus/quiet-mode");
      if (action === "status") {
        const enabled = Boolean(current.quiet_mode);
        show("Quiet mode", enabled
          ? `${ansi.yellow("ON")} · non-critical event notifications are suppressed`
          : `${ansi.green("OFF")} · event notifications are delivered`);
        return;
      }

      const enabled = action === "toggle" ? !Boolean(current.quiet_mode) : action === "on";
      const result = await post("/event-bus/quiet-mode", { enabled });
      const active = Boolean(result.quiet_mode);
      show(
        "Quiet mode updated",
        active
          ? `${ansi.yellow("ON")} · non-critical event notifications are suppressed`
          : `${ansi.green("OFF")} · event notifications are delivered`,
        "success",
      );
    }),
  });

  pi.registerCommand("scope", {
    description: "Show the active project/part isolation boundary",
    handler: async () => show("Active scope", `${scopeLabel}\nTools and agent calls are constrained to this boundary.`),
  });

  pi.registerCommand("model", {
    description: "Choose a routing mode (fallback across everything), a group (fallback within it), or pin one exact backend (no fallback)",
    getArgumentCompletions: async (prefix) => completion([...policyNames, "info", "group", "pin"], prefix),
    handler: async (args, ctx) => guarded("Routing mode", async () => {
      const [action, requested] = words(args);
      if (action === "info") {
        show("Herald routing modes", policies.map((policy: any) =>
          `${policy.name.toUpperCase()}\n  ${policy.description}\n  ${(policy.automatic_order || []).join(" → ")}`
        ).join("\n\n") || "No routing policies are available", "info");
        return;
      }
      if (action === "group") {
        let group = requested;
        if (!group) group = await ctx.ui.select("Group · fails over among its own members only", groupIds) || "";
        if (!group) return;
        const model = ctx.modelRegistry.find("herald", group);
        if (!model || !await pi.setModel(model)) throw new Error(`Could not activate group '${group}'`);
        routeLabel = group;
        ctx.ui.setStatus("herald-route", `group ${group}`);
        show("Group selected", `${group}\n\nRequests fail over among this group's own members if one fails, but never cross into a different group or an unrelated backend.`, "success");
        return;
      }
      if (action === "pin" || action === "backend") {
        let backend = requested;
        if (!backend) backend = await ctx.ui.select("Pin · exact backend, no fallback", individualBackendIds) || "";
        if (!backend) return;
        const model = ctx.modelRegistry.find("herald", backend);
        if (!model || !await pi.setModel(model)) throw new Error(`Could not activate backend '${backend}'`);
        routeLabel = backend;
        ctx.ui.setStatus("herald-route", `pin ${backend}`);
        show("Backend pinned", `${backend}\n\nThe router refuses to substitute a different backend for this: if '${backend}' is unavailable, the request fails instead of silently routing elsewhere. Choose /model again to change this.`, "warning");
        return;
      }
      let selected = action;
      if (!selected) {
        let suggestedPolicy = "";
        if (lastUserInput.trim()) {
          try {
            const suggestion = await request(`/routing/suggest-policy?prompt=${encodeURIComponent(lastUserInput.slice(0, 500))}`);
            suggestedPolicy = suggestion.suggested_policy || "";
          } catch {
            // advisory only -- a failed classification just means no hint, not an error
          }
        }
        const labels = policies.map((policy: any) => {
          const hint = policy.name === suggestedPolicy ? "  (suggested, based on your last message)" : "";
          return `${policy.name} — ${policy.description}${hint}`;
        });
        const choice = await ctx.ui.select("Herald routing behavior", labels);
        selected = policies[labels.indexOf(choice || "")]?.name || "";
      }
      if (selected) await activateMode(selected, ctx);
    }),
  });

  pi.registerCommand("appearance", {
    description: "Choose themes, holiday palettes, syntax colors, and thinking display",
    getArgumentCompletions: async (prefix) => completion(["theme", "holiday", "thinking", ...themeNames], prefix),
    handler: async (args, ctx) => guarded("Appearance", async () => {
      let [section, value] = words(args);
      if (!section) {
        const selection = await ctx.ui.select("Herald appearance", ["Theme & syntax colors", "Thinking display"]);
        if (!selection) return;
        section = selection.startsWith("Thinking") ? "thinking" : "theme";
      }
      if (section === "holiday") {
        value = currentHolidayTheme();
        section = "theme";
      }
      if (section === "theme") {
        if (!value) value = await ctx.ui.select("Theme & syntax palette", ["holiday (automatic)", ...themeNames]) || "";
        if (value === "holiday (automatic)" || value === "holiday") value = currentHolidayTheme();
        if (!value) return;
        const result = ctx.ui.setTheme(value);
        if (!result.success) throw new Error(result.error || `Could not load theme '${value}'`);
        show("Appearance updated", `${value}\nSyntax, Markdown, diffs, tools, and thinking levels now use this palette.`, "success");
        return;
      }
      if (section === "thinking") {
        if (!value) value = await ctx.ui.select("Thinking display level", thinkingLevels) || "";
        if (!thinkingLevels.includes(value)) throw new Error(`Choose: ${thinkingLevels.join(", ")}`);
        pi.setThinkingLevel(value as any);
        show("Thinking display updated", `${value}\nOnly reasoning actually exposed by the selected backend can be displayed.`, "success");
        return;
      }
      if (themeNames.includes(section)) {
        const result = ctx.ui.setTheme(section);
        if (!result.success) throw new Error(result.error || `Could not load theme '${section}'`);
        show("Appearance updated", section, "success");
        return;
      }
      throw new Error("Usage: /appearance [theme [NAME]|holiday|thinking [LEVEL]]");
    }),
  });

  const accountTable = (accounts: any[]) => renderTable(
    [{ header: "On" }, { header: "Name" }, { header: "Provider/Auth" }, { header: "Priority", align: "right" }],
    accounts.map((a: any) => [boolMark(a.enabled), String(a.name), `${a.provider}/${a.auth_kind}`, String(a.priority ?? "-")]),
  );

  pi.registerCommand("accounts", {
    description: "List, add, lane-assign, or activate named Herald accounts",
    getArgumentCompletions: async (prefix) => {
      const payload = await request("/accounts");
      return completion(["list", "add", "lane", "activate", ...(payload.accounts || []).map((a: any) => a.name)], prefix);
    },
    handler: async (args, ctx) => guarded("Accounts", async () => {
      const tokens = words(args);
      const action = (tokens[0] === "activate" || tokens[0] === "add" || tokens[0] === "lane" || tokens[0] === "list") ? tokens.shift() : undefined;

      if (action === "activate") {
        const name = tokens.shift();
        if (!name) throw new Error("Usage: /accounts activate <name>");
        await post(`/accounts/${encodeURIComponent(name)}/activate`);
        show("Account activated", name, "success");
        return;
      }
      if (action === "add") {
        const [name, provider, authKind] = tokens;
        if (!name || !provider || !authKind) throw new Error("Usage: /accounts add <name> <provider> <auth_kind>");
        const result = await post("/accounts", { name, provider, auth_kind: authKind });
        show("Account added", result.name || name, "success");
        return;
      }
      if (action === "lane") {
        const [account, laneName, backendName] = tokens;
        if (!account || !laneName || !backendName) throw new Error("Usage: /accounts lane <account> <lane-name> <backend>");
        const result = await post(`/accounts/${encodeURIComponent(account)}/lanes`, {
          name: laneName, backend_name: backendName,
        });
        show("Account lane added", `${account}/${laneName} → ${backendName}`, "success");
        return;
      }

      const payload = await request("/accounts");
      const accounts = payload.accounts || [];
      const wantTable = tokens.includes("--table");
      if (wantTable || !ctx?.ui?.select || accounts.length === 0) {
        show("Herald accounts", accountTable(accounts));
        return;
      }
      const labels = accounts.map((a: any) => `${boolMark(a.enabled)} ${a.name} — ${a.provider}/${a.auth_kind}`);
      const pick = await ctx.ui.select("Herald accounts — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("Herald accounts", accountTable(accounts));
        return;
      }
      const target = accounts[labels.indexOf(pick)];
      if (!target) return;
      const nextAction = await ctx.ui.select(`${target.name} — what next?`, ["Activate", "Nothing, just looking"]);
      if (nextAction === "Activate") {
        await post(`/accounts/${encodeURIComponent(target.name)}/activate`);
        show("Account activated", target.name, "success");
      }
    }),
  });

  pi.registerCommand("login", {
    description: "Inspect, reauthenticate, poll, or cancel Herald CLI authentication",
    getArgumentCompletions: async (prefix) => completion(["status", "recheck", "poll", "cancel", "code", "provider", "codex", "claude", "antigravity"], prefix),
    handler: async (args, ctx) => guarded("Authentication", async () => {
      const [action, cli, ...remainder] = words(args);
      if (!action) {
        const choice = await ctx.ui.select("Herald accounts & authentication", [
          "Status", "Recheck login status", "Sign in to a CLI", "Native provider OAuth (advanced)",
        ]);
        if (choice === "Recheck login status") {
          const result = await post("/auth/refresh");
          show("Login status rechecked", result.message || JSON.stringify(result, null, 2), "success");
          return;
        }
        if (choice === "Sign in to a CLI") {
          const selected = await ctx.ui.select("CLI account", ["codex", "claude", "antigravity"]);
          if (!selected) return;
          const result = await post("/auth/login/start", { cli: selected });
          show(`Login · ${selected}`, result.output || result.error || JSON.stringify(result, null, 2), result.error ? "error" : "info");
          return;
        }
        if (choice === "Native provider OAuth (advanced)") {
          show("Native provider OAuth", "Run /login provider [provider]. This uses Herald's imported native OAuth flow inside the same login hierarchy.");
          return;
        }
      }
      if (action === "code") {
        if (!cli || !remainder.length) throw new Error("Usage: /login code <cli> <code>");
        const result = await post("/auth/login/code", { cli, code: remainder.join(" ") });
        show(`Login code · ${cli}`, result.output || result.error || JSON.stringify(result), result.error ? "error" : "success");
        return;
      }
      if (action === "poll" || action === "cancel") {
        if (!cli) throw new Error(`Usage: /login ${action} <cli>`);
        const result = action === "poll"
          ? await request(`/auth/login/${encodeURIComponent(cli)}`)
          : await post(`/auth/login/${encodeURIComponent(cli)}/cancel`);
        show(`Login ${action} · ${cli}`, result.output || result.error || JSON.stringify(result, null, 2), result.error ? "error" : "info");
        return;
      }
      const target = action || "";
      if (target === "refresh" || target === "recheck" || target === "all") {
        const result = await post("/auth/refresh");
        show("Login status rechecked", result.message || JSON.stringify(result, null, 2), "success");
        return;
      }
      if (target) {
        const result = await post("/auth/login/start", { cli: target });
        show(`Login · ${target}`, result.output || result.error || JSON.stringify(result, null, 2), result.error ? "error" : "info");
        return;
      }
      const status = await request("/auth/status");
      const lines = (status.clis || []).map((item: any) =>
        `${boolMark(item.status === "logged_in")} ${String(item.cli || item.name).padEnd(16)} ${item.status}`
      );
      show("Authentication", lines.join("\n") || "No CLI profiles reported");
    }),
  });

  pi.registerCommand("tools", {
    description: "List or run tools visible in the current Herald scope",
    getArgumentCompletions: async (prefix) => {
      const payload = await request(`/tools${scopeQuery()}`);
      return completion(["run", ...(payload.tools || []).map((tool: any) => tool.name)], prefix);
    },
    handler: async (args, ctx) => guarded("Tools", async () => {
      const [action, nameArg, ...rest] = words(args);
      if (action === "run") {
        let name = nameArg;
        if (!name) {
          const payload = await request(`/tools${scopeQuery()}`);
          const toolNames = (payload.tools || []).map((tool: any) => String(tool.name));
          if (!toolNames.length) throw new Error("No tools are visible in the current scope");
          name = await ctx.ui.select("Run tool", toolNames) || "";
          if (!name) return;
        }
        let argumentsValue: Json = {};
        const raw = args.trim().slice(action.length).trim().slice(name.length).trim();
        if (raw.startsWith("{")) argumentsValue = JSON.parse(raw);
        else for (const item of rest) {
          const index = item.indexOf("=");
          if (index > 0) argumentsValue[item.slice(0, index)] = item.slice(index + 1);
        }
        const result = await post("/tools/run", { name, arguments: argumentsValue, ...scopeBody() });
        show(`Tool · ${name}`, JSON.stringify(result, null, 2), "success");
        return;
      }
      const payload = await request(`/tools${scopeQuery()}`);
      const needle = args.trim().toLowerCase();
      const rows = (payload.tools || []).filter((tool: any) => !needle || String(tool.name).toLowerCase().includes(needle));
      show("Scoped tools", rows.map((tool: any) =>
        `◆ ${tool.name}\n  ${clip(tool.description || `${tool.package || tool.instance}@${tool.version || "unversioned"}`)}`
      ).join("\n") || "No tools match this scope/filter");
    }),
  });

  const flowTable = (runs: any[]) => renderTable(
    [{ header: "Done" }, { header: "ID" }, { header: "Status" }, { header: "Stage" }, { header: "Name" }],
    runs.map((r: any) => [boolMark(r.status === "completed"), String(r.id).slice(0, 12), String(r.status), `${r.current_stage}/${r.total_stages}`, String(r.name)]),
  );

  pi.registerCommand("flow", {
    description: "List or resume Herald flow runs",
    getArgumentCompletions: async (prefix) => completion(["list", "resume"], prefix),
    handler: async (args, ctx) => guarded("Flow", async () => {
      const [action, id] = words(args);
      if (action === "resume") {
        if (!id) throw new Error("Usage: /flow resume <run-id>");
        const result = await post(`/flow-runs/${encodeURIComponent(id)}/resume`);
        show(`Flow · ${id.slice(0, 12)}`, result.result?.content || JSON.stringify(result, null, 2), "success");
        return;
      }
      if (action && action !== "list") throw new Error("Usage: /flow [list|resume <run-id>]");
      const payload = await request("/flow-runs?limit=30");
      const runs = payload.runs || [];
      const wantTable = words(args).includes("--table");
      if (wantTable || !ctx?.ui?.select || runs.length === 0) {
        show("Persistent flows", flowTable(runs));
        return;
      }
      const labels = runs.map((run: any) => `${boolMark(run.status === "completed")} ${run.name} — ${run.status} (${run.current_stage}/${run.total_stages})`);
      const pick = await ctx.ui.select("Persistent flows — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("Persistent flows", flowTable(runs));
        return;
      }
      const target = runs[labels.indexOf(pick)];
      if (!target) return;
      if (target.status === "completed") {
        show(`Flow · ${target.name}`, `Already completed (${target.current_stage}/${target.total_stages}).`);
        return;
      }
      const doResume = await ctx.ui.confirm(`Resume flow '${target.name}'?`, `Currently at stage ${target.current_stage}/${target.total_stages}.`);
      if (!doResume) return;
      const result = await post(`/flow-runs/${encodeURIComponent(target.id)}/resume`);
      show(`Flow · ${target.id.slice(0, 12)}`, result.result?.content || JSON.stringify(result, null, 2), "success");
    }),
  });

  const memoryTable = (sessions: any[]) => renderTable(
    [{ header: "ID" }, { header: "Name" }, { header: "Model" }, { header: "Turns", align: "right" }],
    sessions.map((s: any) => [String(s.id).slice(0, 12), String(s.name), String(s.model), String(s.turn_count)]),
  );

  pi.registerCommand("memory", {
    description: "List, inspect, reset, delete, export, or import named encrypted agent memories",
    getArgumentCompletions: async (prefix) => completion(["list", "inspect", "reset", "delete", "export", "import"], prefix),
    handler: async (args, ctx) => guarded("Memory", async () => {
      const [action, id, path] = words(args);
      if (action === "inspect") {
        if (!id) throw new Error("Usage: /memory inspect <session-id>");
        const value = await request(`/agent-sessions/${encodeURIComponent(id)}`);
        show(`Memory | ${String(value.name || id)}`,
          `${value.model} | ${value.turn_count} turns | ${value.status}\n${value.project || "global"}/${value.part || "-"}`);
        return;
      }
      if (action === "reset") {
        if (!id) throw new Error("Usage: /memory reset <session-id>");
        const value = await post(`/agent-sessions/${encodeURIComponent(id)}/reset`);
        show("Memory reset", `${value.session.name} | ${value.session.memory}`, "success");
        return;
      }
      if (action === "delete") {
        if (!id) throw new Error("Usage: /memory delete <session-id>");
        await request(`/agent-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        show("Memory deleted", id, "success");
        return;
      }
      if (action === "export") {
        if (!id || !path) throw new Error("Usage: /memory export <session-id> <path>");
        const value = await request(`/agent-sessions/${encodeURIComponent(id)}/export`);
        const target = resolvePath(path);
        writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
        show("Memory exported", `${id} → ${target} (contains private memory)`, "success");
        return;
      }
      if (action === "import") {
        if (!id || !path) throw new Error("Usage: /memory import <session-id> <path>");
        const raw = readFileSync(resolvePath(path), "utf-8");
        const result = await post(`/agent-sessions/${encodeURIComponent(id)}/import`, { data: JSON.parse(raw) });
        show("Memory imported", `${path} → ${id}`, result.error ? "error" : "success");
        return;
      }
      if (action && action !== "list") throw new Error("Usage: /memory [list|inspect ID|reset ID|delete ID|export ID PATH|import ID PATH]");
      const payload = await request("/agent-sessions?limit=50");
      const sessions = payload.sessions || [];
      const wantTable = words(args).includes("--table");
      if (wantTable || !ctx?.ui?.select || sessions.length === 0) {
        show("Agent memories", memoryTable(sessions));
        return;
      }
      const labels = sessions.map((item: any) => `${item.name} — ${item.model} · ${item.turn_count} turns`);
      const pick = await ctx.ui.select("Agent memories — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("Agent memories", memoryTable(sessions));
        return;
      }
      const target = sessions[labels.indexOf(pick)];
      if (!target) return;
      const value = await request(`/agent-sessions/${encodeURIComponent(target.id)}`);
      show(`Memory | ${String(value.name || target.id)}`,
        `${value.model} | ${value.turn_count} turns | ${value.status}\n${value.project || "global"}/${value.part || "-"}`);
      const nextAction = await ctx.ui.select(`${target.name} — what next?`, ["Reset memory", "Delete memory", "Nothing, just looking"]);
      if (nextAction === "Reset memory") {
        const sure = await ctx.ui.confirm(`Reset memory for '${target.name}'?`, "This clears the memory while keeping the agent.");
        if (!sure) return;
        const reset = await post(`/agent-sessions/${encodeURIComponent(target.id)}/reset`);
        show("Memory reset", `${reset.session.name} | ${reset.session.memory}`, "success");
      } else if (nextAction === "Delete memory") {
        const sure = await ctx.ui.confirm(`Permanently delete memory '${target.name}'?`, "This cannot be undone.");
        if (!sure) return;
        await request(`/agent-sessions/${encodeURIComponent(target.id)}`, { method: "DELETE" });
        show("Memory deleted", target.name, "success");
      }
    }),
  });

  pi.registerCommand("capture", {
    description: "Start or inspect protected G4F Kapture sessions",
    getArgumentCompletions: async (prefix) => {
      const payload = await request("/capture/g4f/accounts");
      return completion(["list", ...(payload.accounts || []).map((a: any) => a.name)], prefix);
    },
    handler: async (args, ctx) => guarded("G4F capture", async () => {
      const captureAccountTable = (accounts: any[]) => renderTable(
        [{ header: "On" }, { header: "Name" }, { header: "Email" }, { header: "Session" }],
        accounts.map((a: any) => [boolMark(a.enabled), String(a.name), String(a.email_hint || "-"), a.session_materialized ? "ready" : "none"]),
      );
      const account = args.trim();
      if (!account) {
        const payload = await request("/capture/g4f/accounts");
        const accounts = payload.accounts || [];
        if (ctx?.ui?.select && accounts.length > 0) {
          const labels = accounts.map((item: any) =>
            `${boolMark(item.enabled)} ${item.name}${item.email_hint ? ` (${item.email_hint})` : ""} — ${item.session_materialized ? "session ready" : "no session"}`
          );
          const pick = await ctx.ui.select("G4F accounts — pick one", [...labels, "Show as table"]);
          if (!pick) return;
          if (pick === "Show as table") {
            show("G4F accounts", captureAccountTable(accounts));
            return;
          }
          const target = accounts[labels.indexOf(pick)];
          if (!target) return;
          const doCapture = await ctx.ui.confirm(`Start a secure capture for '${target.name}'?`, target.session_materialized ? "This will refresh the existing session." : "No session exists yet for this account.");
          if (!doCapture) return;
          const result = await post("/capture/g4f/sessions", { account: target.name, timeout: 120 });
          show(`Secure capture · ${target.name}`, `${result.instruction}\nCapture: ${result.session.id.slice(0, 12)}`, "warning");
          return;
        }
        show("G4F accounts", captureAccountTable(accounts));
        return;
      }
      if (account === "list") {
        const payload = await request("/capture/g4f/sessions");
        const sessions = payload.sessions || [];
        show("G4F captures", renderTable(
          [{ header: "ID" }, { header: "Account" }, { header: "Status" }],
          sessions.map((item: any) => [String(item.id).slice(0, 12), String(item.account), String(item.status)]),
        ));
        return;
      }
      const result = await post("/capture/g4f/sessions", { account, timeout: 120 });
      show(`Secure capture · ${account}`, `${result.instruction}\nCapture: ${result.session.id.slice(0, 12)}`, "warning");
    }),
  });

  pi.registerCommand("integrations", {
    description: "Discover or import external CLI MCP connections",
    handler: async (args, ctx) => guarded("Integrations", async () => {
      const [action, owner, name] = words(args);
      if (action === "import") {
        if (!owner || !name) throw new Error("Usage: /integrations import <owner> <name>");
        const result = await post("/integrations/import", { owner, name, scope: project ? "project" : "global", project });
        show("Integration imported", `${owner}/${name} → ${result.name}`, "success");
        return;
      }
      const payload = await request("/integrations/discover");
      const integrations = payload.integrations || [];
      const integrationTable = () => renderTable(
        [{ header: "Imported" }, { header: "Owner" }, { header: "Name" }, { header: "Transport" }],
        integrations.map((item: any) => [boolMark(item.imported), String(item.owner), String(item.name), String(item.transport)]),
      );
      const wantTable = words(args).includes("--table");
      if (wantTable || !ctx?.ui?.select || integrations.length === 0) {
        show("External integrations", integrationTable());
        return;
      }
      const labels = integrations.map((item: any) => `${boolMark(item.imported)} ${item.owner}/${item.name} — ${item.transport}`);
      const pick = await ctx.ui.select("External integrations — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("External integrations", integrationTable());
        return;
      }
      const target = integrations[labels.indexOf(pick)];
      if (!target) return;
      if (target.imported) {
        show(`Integration · ${target.owner}/${target.name}`, "Already imported.");
        return;
      }
      const doImport = await ctx.ui.confirm(`Import '${target.owner}/${target.name}'?`, `Transport: ${target.transport}`);
      if (!doImport) return;
      const result = await post("/integrations/import", { owner: target.owner, name: target.name, scope: project ? "project" : "global", project });
      show("Integration imported", `${target.owner}/${target.name} → ${result.name}`, "success");
    }),
  });

  pi.registerCommand("mcp", {
    description: "Manage controlled MCP groups and shared CLI access",
    getArgumentCompletions: async (prefix) => completion(["list", "show", "access", "create", "add", "remove", "bind", "unbind", "delete"], prefix),
    handler: async (args, ctx) => guarded("MCP groups", async () => {
      const [action, first, second, third] = words(args);
      if (action === "show") {
        if (!first) throw new Error("Usage: /mcp show <group>");
        const value = await request(`/mcp-groups/${encodeURIComponent(first)}`);
        const tools = (value.tools || []).map((item: any) =>
          `* ${item.name}${item.allowed_tools ? ` | allow: ${item.allowed_tools.join(", ")}` : " | all tools"}`
        );
        const bindings = (value.bindings || []).map((item: any) =>
          `* ${item.target_type}:${item.target_key}`
        );
        show(`MCP group | ${value.name}`, [...tools, "", "Bindings", ...bindings].join("\n"));
        return;
      }
      if (action === "access") {
        const query = first
          ? `?profile=${encodeURIComponent(first)}`
          : scopeQuery();
        const value = await request(`/mcp-access${query}`);
        show("Resolved MCP access", (value.tools || []).map((item: any) =>
          `* ${item.name.padEnd(28)} ${item.instance}`
        ).join("\n") || "No tools assigned to this context");
        return;
      }
      if (action === "create") {
        if (!first) throw new Error("Usage: /mcp create <group>");
        const value = await post("/mcp-groups", {name: first, description: "Created in Herald CLI"});
        show("MCP group created", value.name, "success");
        return;
      }
      if (action === "add") {
        if (!first || !second) throw new Error("Usage: /mcp add <group> <server> [tool1,tool2]");
        const value = await post(`/mcp-groups/${encodeURIComponent(first)}/tools`, {
          tool: second, allowed_tools: third ? third.split(",").filter(Boolean) : null,
        });
        show("MCP server grouped", `${second} -> ${value.name}`, "success");
        return;
      }
      if (action === "bind") {
        if (!first || !second) throw new Error("Usage: /mcp bind <group> <global|project|part|cli> [target]");
        const value = await post(`/mcp-groups/${encodeURIComponent(first)}/bindings`, {
          target_type: second, target_key: third || "*",
        });
        show("MCP group bound", `${value.name} -> ${second}:${third || "*"}`, "success");
        return;
      }
      if (action === "unbind") {
        if (!first || !second) throw new Error("Usage: /mcp unbind <group> <global|project|part|cli> [target]");
        await request(`/mcp-groups/${encodeURIComponent(first)}/bindings/${encodeURIComponent(second)}/${encodeURIComponent(third || "*")}`, { method: "DELETE" });
        show("MCP group unbound", `${first} -x- ${second}:${third || "*"}`, "success");
        return;
      }
      if (action === "remove") {
        if (!first || !second) throw new Error("Usage: /mcp remove <group> <tool>");
        await request(`/mcp-groups/${encodeURIComponent(first)}/tools/${encodeURIComponent(second)}`, { method: "DELETE" });
        show("MCP server removed from group", `${second} -x- ${first}`, "success");
        return;
      }
      if (action === "delete") {
        if (!first) throw new Error("Usage: /mcp delete <group>");
        const sure = await ctx.ui.confirm(`Delete MCP group '${first}'?`, "This removes the group and its bindings, not the underlying MCP servers.");
        if (!sure) return;
        await request(`/mcp-groups/${encodeURIComponent(first)}`, { method: "DELETE" });
        show("MCP group deleted", first, "success");
        return;
      }
      if (action) throw new Error("Usage: /mcp [show|access|create|add|remove|bind|unbind|delete]");
      const mcpGroupTable = (groups: any[]) => renderTable(
        [{ header: "Name" }, { header: "Servers", align: "right" }, { header: "Bindings", align: "right" }],
        groups.map((item: any) => [String(item.name), String(item.tools.length), String(item.bindings.length)]),
      );
      const payload = await request("/mcp-groups");
      const groups = payload.groups || [];
      const wantTable = words(args).includes("--table");
      if (wantTable || !ctx?.ui?.select || groups.length === 0) {
        show("Controlled MCP groups", mcpGroupTable(groups));
        return;
      }
      const labels = groups.map((item: any) => `${item.name} — ${item.tools.length} servers, ${item.bindings.length} bindings`);
      const pick = await ctx.ui.select("Controlled MCP groups — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("Controlled MCP groups", mcpGroupTable(groups));
        return;
      }
      const target = groups[labels.indexOf(pick)];
      if (!target) return;
      const value = await request(`/mcp-groups/${encodeURIComponent(target.name)}`);
      const tools = (value.tools || []).map((item: any) =>
        `* ${item.name}${item.allowed_tools ? ` | allow: ${item.allowed_tools.join(", ")}` : " | all tools"}`
      );
      const bindings = (value.bindings || []).map((item: any) => `* ${item.target_type}:${item.target_key}`);
      show(`MCP group | ${value.name}`, [...tools, "", "Bindings", ...bindings].join("\n"));
      const nextAction = await ctx.ui.select(`${target.name} — what next?`, ["Delete group", "Nothing, just looking"]);
      if (nextAction === "Delete group") {
        const sure = await ctx.ui.confirm(`Delete MCP group '${target.name}'?`, "This removes the group and its bindings, not the underlying MCP servers.");
        if (!sure) return;
        await request(`/mcp-groups/${encodeURIComponent(target.name)}`, { method: "DELETE" });
        show("MCP group deleted", target.name, "success");
      }
    }),
  });

  pi.registerCommand("events", {
    description: "Show sanitized Herald lifecycle events",
    handler: async (args) => guarded("Events", async () => {
      const topic = args.trim();
      const payload = await request(`/events?limit=25${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`);
      show("Router events", (payload.events || []).map((event: any) =>
        `${event.created_at.slice(11, 19)}  ${event.topic}\n  ${clip(JSON.stringify(event.payload), 110)}`
      ).join("\n") || "No matching events");
    }),
  });

  const hookTable = (hooks: any[]) => renderTable(
    [{ header: "On" }, { header: "Name" }, { header: "Event pattern" }, { header: "Transport" }],
    hooks.map((h: any) => [boolMark(h.enabled), String(h.name), String(h.pattern), String(h.transport)]),
  );

  pi.registerCommand("hooks", {
    description: "List, add, or remove Herald event hooks",
    getArgumentCompletions: async (prefix) => completion(["list", "add", "remove"], prefix),
    handler: async (args, ctx) => guarded("Hooks", async () => {
      const tokens = words(args);
      const action = (tokens[0] === "add" || tokens[0] === "remove" || tokens[0] === "list") ? tokens.shift() : undefined;

      if (action === "add") {
        const flags: Record<string, string> = {};
        const name = tokens.shift();
        while (tokens.length) {
          const flag = tokens.shift() || "";
          if (!["--event", "--url", "--command-json", "--secret-ref"].includes(flag)) {
            throw new Error(`Unknown hook option '${flag}'`);
          }
          const value = tokens.shift();
          if (!value) throw new Error(`${flag} requires a value`);
          flags[flag] = value;
        }
        if (!name || !flags["--event"] || (Boolean(flags["--url"]) === Boolean(flags["--command-json"]))) {
          throw new Error("Usage: /hooks add <name> --event PATTERN (--url URL|--command-json JSON) [--secret-ref REF]");
        }
        const transport = flags["--url"] ? "http" : "command";
        const config = flags["--url"] ? { url: flags["--url"] } : { command: JSON.parse(flags["--command-json"]) };
        const result = await post("/hooks", {
          name, pattern: flags["--event"], transport, config, secret_ref: flags["--secret-ref"] || null,
        });
        show("Hook added", `${result.name || name} watches ${flags["--event"]}`, "success");
        return;
      }
      if (action === "remove") {
        const name = tokens.shift();
        if (!name || tokens.length) throw new Error("Usage: /hooks remove <name>");
        await request(`/hooks/${encodeURIComponent(name)}`, { method: "DELETE" });
        show("Hook removed", name, "success");
        return;
      }

      const payload = await request("/hooks");
      const hooks = payload.hooks || [];
      const wantTable = tokens.includes("--table");
      if (wantTable || !ctx?.ui?.select || hooks.length === 0) {
        show("Event hooks", hookTable(hooks));
        return;
      }
      const labels = hooks.map((h: any) => `${boolMark(h.enabled)} ${h.name} — ${h.pattern} (${h.transport})`);
      const pick = await ctx.ui.select("Event hooks — pick one", [...labels, "Show as table"]);
      if (!pick) return;
      if (pick === "Show as table") {
        show("Event hooks", hookTable(hooks));
        return;
      }
      const target = hooks[labels.indexOf(pick)];
      if (!target) return;
      show(`Hook · ${target.name}`, `Pattern: ${target.pattern}\nTransport: ${target.transport}\nEnabled: ${target.enabled ? "yes" : "no"}`);
      const nextAction = await ctx.ui.select(`${target.name} — what next?`, ["Remove", "Nothing, just looking"]);
      if (nextAction === "Remove") {
        const sure = await ctx.ui.confirm(`Remove hook '${target.name}'?`, "This cannot be undone.");
        if (!sure) return;
        await request(`/hooks/${encodeURIComponent(target.name)}`, { method: "DELETE" });
        show("Hook removed", target.name, "success");
      }
    }),
  });

  pi.registerCommand("dashboard", {
    description: "Open the Herald Account Console or show its address",
    getArgumentCompletions: async (prefix) => completion(["open", "url"], prefix),
    handler: async (args, ctx) => guarded("Account Console", async () => {
      const url = `${routerUrl}/ui`;
      let action = args.trim();
      if (!action) action = (await ctx.ui.select("Herald Account Console", ["Open in browser", "Show URL"]))?.startsWith("Open") ? "open" : "url";
      if (action === "url") {
        show("Account Console", `${url}\nManage accounts, logins, keys, sessions, and usage here. Coding stays in the Herald CLI.`);
        return;
      }
      if (action !== "open") throw new Error("Usage: /dashboard [open|url]");
      if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
        show("Account Console · remote shell", `${url}\nOpen this address through your SSH tunnel or Tailscale connection; Herald will not launch a browser on the server.`, "warning");
        return;
      }
      const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      const opened = await pi.exec(command, commandArgs);
      if (opened.code !== 0) throw new Error(opened.stderr || `Could not open ${url}`);
      show("Account Console", `${url}\nOpened in your default browser.`, "success");
    }),
  });

  pi.registerCommand("update", {
    description: "Update Herald and its routing engine to the latest build",
    handler: async (_args, ctx) => guarded("Update", async () => {
      ctx.ui.notify("Checking for Herald updates…", "info");
      const res = await pi.exec("herald", ["update"]);
      if (res.code === 0) {
        show("Herald Update", res.stdout || "Herald is up to date!", "success");
        ctx.ui.notify("Herald updated successfully!", "success");
      } else {
        show("Herald Update", res.stderr || res.stdout || "Update failed", "error");
      }
    }),
  });

  pi.registerCommand("assistant", {
    description: "Ultimate Assistant main-node status, active background jobs, or full multi-agent chat turn",
    getArgumentCompletions: async (prefix) => completion(["status", "ask", "work", "cancel"], prefix),
    handler: async (args, ctx) => guarded("Ultimate Assistant", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "status";
      if (sub === "status") {
        const [agentsRes, convRes, tasksRes, memRes, canvasRes, modRes, workRes] = await Promise.all([
          assistantRequest("/api/agents").catch(() => ({ agents: [] })),
          assistantRequest("/api/conversations").catch(() => ({ conversations: [] })),
          assistantRequest("/api/tasks").catch(() => ({ tasks: [] })),
          assistantRequest("/api/memories").catch(() => ({ memories: [] })),
          assistantRequest("/api/canvas").catch(() => ({ cards: [] })),
          assistantRequest("/api/modules").catch(() => ({ modules: [] })),
          assistantRequest("/api/assistant-work").catch(() => ({ jobs: [] })),
        ]);
        const agents = agentsRes.agents || [];
        const convs = convRes.conversations || [];
        const tasks = tasksRes.tasks || [];
        const openTasks = tasks.filter((t: any) => t.status !== "done" && t.status !== "completed");
        const memories = memRes.memories || [];
        const cards = canvasRes.cards || [];
        const modules = modRes.modules || [];
        const jobs = (workRes.jobs || []).filter((j: any) => j.status === "running" || j.status === "queued");
        show("Ultimate Assistant · Main Node", [
          `● Main node      ${assistantBaseUrl}`,
          `◆ Specialists    ${agents.map((a: any) => a.name).join(", ") || "none"}`,
          `◆ Conversations  ${convs.length} shared thread(s)${_activeAssistantConversationId ? ` · active: ${_activeAssistantConversationId}` : ""}`,
          `◆ Tasks          ${openTasks.length} open / ${tasks.length} total`,
          `◆ Memories       ${memories.length} stored fact(s)`,
          `◆ Canvas         ${cards.length} live overlay card(s)`,
          `◆ Modules        ${modules.filter((m: any) => m.enabled).length}/${modules.length} enabled`,
          `◆ Active work    ${jobs.length} running job(s)`,
          "",
          "Note: Voice (SUPER+A), Text (SUPER+ALT+A), Overlay Canvas, and Phone App remain the primary assistant interfaces.",
          "Use `/assistant ask <prompt>` or `/agents run <specialist> <task>` to invoke Ultimate Assistant from Pi.",
        ].join("\n"), "success");
        return;
      }
      if (sub === "work") {
        const workRes = await assistantRequest("/api/assistant-work");
        const jobs = workRes.jobs || [];
        if (!jobs.length) {
          show("Ultimate Assistant · Active Work", "No background or active assistant jobs.");
          return;
        }
        show("Ultimate Assistant · Active Work", renderTable(
          [{ header: "Job ID" }, { header: "Status" }, { header: "Summary" }],
          jobs.map((j: any) => [String(j.id || ""), String(j.status || ""), clip(String(j.summary || j.prompt || ""), 54)]),
        ));
        return;
      }
      if (sub === "cancel") {
        const jobId = tokens[1];
        if (!jobId) throw new Error("Usage: /assistant cancel <job_id>");
        await assistantPost(`/api/assistant-work/${encodeURIComponent(jobId)}/cancel`, {});
        show("Ultimate Assistant · Work Cancelled", jobId, "warning");
        return;
      }
      const prompt = sub === "ask" ? args.trim().replace(/^ask\s+/i, "") : args.trim();
      if (!prompt) throw new Error("Usage: /assistant [status|work|cancel <id>|ask <message>]");
      ctx?.ui?.notify?.("Ultimate Assistant thinking…", "info");
      const out = await assistantChat(prompt, {
        onProgress: (stage) => {
          ctx?.ui?.setWorkingMessage?.(`Ultimate Assistant: ${stage}`);
        },
      });
      const meta = [
        out.agent ? `agent: ${out.agent}` : "",
        out.model ? `model: ${out.model}` : "",
        out.conversation_id ? `conversation: ${out.conversation_id}` : "",
      ].filter(Boolean).join(" · ");
      show(`Ultimate Assistant${meta ? ` (${meta})` : ""}`, out.reply || (out as any).text || "(empty response)", "success");
    }),
  });

  pi.registerCommand("agents", {
    description: "Inspect or run Ultimate Assistant specialist agents (companion, operator, builder, researcher, tutor, planner)",
    getArgumentCompletions: async (prefix) => completion(["list", "run"], prefix),
    handler: async (args, ctx) => guarded("Specialist Agents", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "list";
      if (sub === "run") {
        const agentName = tokens[1];
        const taskPrompt = args.trim().replace(/^run\s+\S+\s*/i, "");
        if (!agentName || !taskPrompt) {
          throw new Error("Usage: /agents run <companion|operator|builder|researcher|tutor|planner> <task>");
        }
        ctx?.ui?.notify?.(`Running Ultimate Assistant specialist '${agentName}'…`, "info");
        const result = await assistantPost("/api/agents/run", {
          agent: agentName,
          task: taskPrompt,
          conversation_id: _activeAssistantConversationId,
        });
        show(`Specialist · ${result.agent || agentName} (${result.model || "routed"})`, String(result.reply || result.text || JSON.stringify(result, null, 2)), result.ok === false ? "warning" : "success");
        return;
      }
      const payload = await assistantRequest("/api/agents");
      const agents = payload.agents || [];
      show("Ultimate Assistant · Specialist Agents", renderTable(
        [{ header: "Agent" }, { header: "Mode" }, { header: "Tools" }, { header: "Description" }],
        agents.map((a: any) => [
          String(a.name),
          String(a.routing_mode || ""),
          String((a.allowed_tools || []).length || "all"),
          clip(String(a.description || ""), 48),
        ]),
      ));
    }),
  });

  pi.registerCommand("conversations", {
    description: "Browse, inspect, or switch shared Ultimate Assistant conversations",
    getArgumentCompletions: async (prefix) => completion(["list", "show", "use", "delete"], prefix),
    handler: async (args) => guarded("Assistant Conversations", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "list";
      if (sub === "use") {
        _activeAssistantConversationId = tokens[1] || null;
        show("Assistant Conversation", _activeAssistantConversationId ? `Bound to conversation ${_activeAssistantConversationId}` : "Cleared active conversation binding (next turn starts fresh).", "success");
        return;
      }
      if (sub === "show") {
        const convId = tokens[1] || _activeAssistantConversationId;
        if (!convId) throw new Error("Usage: /conversations show <conversation_id>");
        const data = await assistantRequest(`/api/conversations/${encodeURIComponent(convId)}`);
        const msgs = (data.messages || []).slice(-12).map((m: any) => `[${m.role}] ${clip(String(m.content || ""), 160)}`);
        show(`Conversation · ${data.title || convId}`, msgs.join("\n\n") || "No messages");
        return;
      }
      if (sub === "delete") {
        const convId = tokens[1];
        if (!convId) throw new Error("Usage: /conversations delete <conversation_id>");
        await assistantRequest(`/api/conversations/${encodeURIComponent(convId)}`, { method: "DELETE" });
        if (_activeAssistantConversationId === convId) _activeAssistantConversationId = null;
        show("Conversation Deleted", convId, "warning");
        return;
      }
      const payload = await assistantRequest("/api/conversations");
      const convs = (payload.conversations || []).slice(0, 20);
      show("Ultimate Assistant · Conversations", renderTable(
        [{ header: "ID" }, { header: "Title" }, { header: "Updated" }],
        convs.map((c: any) => [
          `${c.id === _activeAssistantConversationId ? "● " : ""}${String(c.id)}`,
          clip(String(c.title || "Untitled"), 44),
          String(c.updated_at || "").slice(0, 19),
        ]),
      ));
    }),
  });

  pi.registerCommand("tasks", {
    description: "List, add, or complete Ultimate Assistant tasks and commitments",
    getArgumentCompletions: async (prefix) => completion(["list", "add", "done"], prefix),
    handler: async (args) => guarded("Assistant Tasks", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "list";
      if (sub === "add") {
        const title = args.trim().replace(/^add\s+/i, "");
        if (!title) throw new Error("Usage: /tasks add <title>");
        const created = await assistantPost("/api/tasks", { title });
        show("Task Created", `${created.id || ""}  ${created.title || title}`, "success");
        return;
      }
      if (sub === "done") {
        const taskId = tokens[1];
        if (!taskId) throw new Error("Usage: /tasks done <task_id>");
        await assistantRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "done" }),
        });
        show("Task Completed", taskId, "success");
        return;
      }
      const payload = await assistantRequest("/api/tasks");
      const tasks = payload.tasks || [];
      if (!tasks.length) {
        show("Ultimate Assistant · Tasks", "No tasks in the commitment store.");
        return;
      }
      show("Ultimate Assistant · Tasks", renderTable(
        [{ header: "ID" }, { header: "Status" }, { header: "Title" }, { header: "Due" }],
        tasks.slice(0, 25).map((t: any) => [
          String(t.id),
          String(t.status || "open"),
          clip(String(t.title || ""), 44),
          String(t.due_at || "—").slice(0, 16),
        ]),
      ));
    }),
  });

  pi.registerCommand("canvas", {
    description: "Inspect, pin, or clear live cards on the Ultimate Assistant desktop overlay canvas",
    getArgumentCompletions: async (prefix) => completion(["list", "show", "clear"], prefix),
    handler: async (args) => guarded("Assistant Canvas", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "list";
      if (sub === "clear") {
        await assistantRequest("/api/canvas", { method: "DELETE" });
        show("Canvas Cleared", "Cleared all live cards from the Ultimate Assistant overlay canvas.", "success");
        return;
      }
      if (sub === "show") {
        const rest = args.trim().replace(/^show\s+/i, "");
        const [rawTitle, ...bodyParts] = rest.split("|");
        const title = (rawTitle || "Herald Pi Note").trim();
        const body = (bodyParts.length ? bodyParts.join("|") : rest).trim();
        if (!body) throw new Error("Usage: /canvas show <title> | <markdown body>");
        await assistantPost("/api/canvas", { kind: "markdown", title, body });
        show("Canvas Card Pinned", `${title}\n${body}`, "success");
        return;
      }
      const payload = await assistantRequest("/api/canvas");
      const cards = payload.cards || [];
      if (!cards.length) {
        show("Ultimate Assistant · Canvas", "No active cards on the desktop overlay canvas.");
        return;
      }
      show("Ultimate Assistant · Canvas", cards.map((c: any) =>
        `◆ [${c.kind || "card"}] ${c.title || c.id}\n  ${clip(String(c.body || JSON.stringify(c.data || {})), 120)}`
      ).join("\n\n"));
    }),
  });

  pi.registerCommand("skills", {
    description: "List Ultimate Assistant learned skills and teach-mode recordings",
    getArgumentCompletions: async (prefix) => completion(["list", "recordings"], prefix),
    handler: async (args) => guarded("Assistant Skills", async () => {
      const sub = words(args)[0] || "list";
      if (sub === "recordings") {
        const recPayload = await assistantRequest("/api/teach/recordings");
        const recs = recPayload.recordings || [];
        if (!recs.length) {
          show("Teach Recordings", "No teach-mode recordings stored yet.");
          return;
        }
        show("Teach Recordings", renderTable(
          [{ header: "ID" }, { header: "Name" }, { header: "Events" }],
          recs.map((r: any) => [String(r.id || ""), String(r.name || ""), String((r.events || []).length || r.event_count || 0)]),
        ));
        return;
      }
      const res = await post("/tools/run", {
        name: "list_skills",
        arguments: {},
        project: assistantProject,
        part: assistantPart,
      });
      const rawOut = res?.result?.structuredContent?.result ?? res?.result?.structuredContent ?? res?.result ?? res;
      let out: any = rawOut;
      if (typeof rawOut === "string") {
        try { out = JSON.parse(rawOut); } catch { out = { skills: [] }; }
      }
      const skills = out?.skills || [];
      if (!skills.length) {
        show("Ultimate Assistant · Learned Skills", "No learned skills saved yet. Use `/skills recordings` to inspect teach-mode recordings.");
        return;
      }
      show("Ultimate Assistant · Learned Skills", renderTable(
        [{ header: "Name" }, { header: "Description" }, { header: "Steps" }],
        skills.map((s: any) => [String(s.name || ""), clip(String(s.description || ""), 48), String((s.steps || []).length)]),
      ));
    }),
  });

  pi.registerCommand("modules", {
    description: "Inspect or manage Ultimate Assistant optional capability modules",
    getArgumentCompletions: async (prefix) => completion(["list", "install", "enable", "disable", "status"], prefix),
    handler: async (args) => guarded("Assistant Modules", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "list";
      if (["install", "enable", "disable", "status"].includes(sub)) {
        const modId = tokens[1];
        if (!modId) throw new Error(`Usage: /modules ${sub} <module_id>`);
        const res = sub === "status"
          ? await assistantRequest(`/api/modules/${encodeURIComponent(modId)}/status`)
          : await assistantPost(`/api/modules/${encodeURIComponent(modId)}/${sub}`, {});
        show(`Module · ${modId} (${sub})`, JSON.stringify(res, null, 2), "success");
        return;
      }
      const payload = await assistantRequest("/api/modules");
      const modules = payload.modules || [];
      if (!modules.length) {
        show("Ultimate Assistant · Modules", "No optional modules registered.");
        return;
      }
      show("Ultimate Assistant · Modules", renderTable(
        [{ header: "ID" }, { header: "Enabled" }, { header: "Installed" }, { header: "Description" }],
        modules.map((m: any) => [
          String(m.id || m.name),
          boolMark(Boolean(m.enabled)),
          boolMark(Boolean(m.installed)),
          clip(String(m.description || ""), 46),
        ]),
      ));
    }),
  });

  pi.registerCommand("omarchy", {
    description: "Inspect and manage Omarchy Linux (profile, commands, keybindings, reference docs, changes, undo, crashes)",
    getArgumentCompletions: async (prefix) => completion(["profile", "commands", "keybindings", "ref", "changes", "undo", "crashes"], prefix),
    handler: async (args) => guarded("Omarchy Environment", async () => {
      const tokens = words(args);
      const sub = tokens[0] || "profile";
      const rest = args.trim().slice(sub.length).trim();
      const runEnvTool = async (toolName: string, toolArgs: Record<string, any> = {}) => {
        const r = await post("/tools/run", {
          name: toolName,
          arguments: toolArgs,
          project: assistantProject,
          part: assistantPart,
        });
        const sc = r?.result?.structuredContent?.result ?? r?.result?.structuredContent ?? r?.result ?? r;
        if (typeof sc === "string") {
          try { return JSON.parse(sc); } catch { return { raw: sc }; }
        }
        return sc;
      };
      if (sub === "profile") {
        // The omarchy module (Ultimate Assistant) carries the Omarchy profile; older backends kept it in environment_profile.
        let prof = await runEnvTool("omarchy_profile").catch(() => null);
        if (!prof || prof.error || prof.raw) prof = (await runEnvTool("environment_profile"))?.omarchy;
        show("Omarchy · Live System Profile", JSON.stringify(prof, null, 2));
        return;
      }
      if (sub === "commands") {
        const cmds = await runEnvTool("omarchy_commands", { search: rest });
        const list = (cmds.commands || []).map((c: any) => `${String(c.name || "").padEnd(34)} ${c.summary || ""}`);
        show(`Omarchy Commands (${cmds.count || list.length})`, list.slice(0, 60).join("\n") || "No matching commands");
        return;
      }
      if (sub === "keybindings" || sub === "keys") {
        const kb = await runEnvTool("omarchy_keybindings", { search: rest });
        const rows = kb.keybindings || kb.bindings || [];
        const bindings = rows.map((b: any) =>
          b.keys ? `${String(b.keys).padEnd(28)} ${b.description || ""}` : `[${b.source}] ${b.kind}: ${(b.args || []).join("  ")}`
        );
        show(`Omarchy Keybindings (${kb.count || bindings.length})`, bindings.slice(0, 60).join("\n") || "No matching keybindings");
        return;
      }
      if (sub === "ref" || sub === "docs") {
        const ref = await runEnvTool("omarchy_reference", { topic: rest });
        const body = ref.content
          || (Array.isArray(ref.files)
            ? ref.files.map((f: any) => `### ${f.path}\n${f.content}`).join("\n\n")
            : (ref.files && typeof ref.files === "object"
              ? Object.entries(ref.files).map(([k, v]) => `### ${k}\n${v}`).join("\n\n")
              : JSON.stringify(ref, null, 2)));
        show(`Omarchy Reference${rest ? ` · ${rest}` : ""}`, body);
        return;
      }
      if (sub === "changes") {
        const ch = await runEnvTool("environment_changes", { limit: 20 });
        const rows = ch.changes || [];
        show("Omarchy · Backed-up Config Changes", renderTable(
          [{ header: "ID" }, { header: "Action" }, { header: "Path" }, { header: "When" }],
          rows.map((c: any) => [String(c.id), String(c.action || c.kind || ""), clip(String(c.path), 42), String(c.created_at || c.timestamp || "").slice(0, 19)]),
        ));
        return;
      }
      if (sub === "undo") {
        const res = await runEnvTool("undo_environment_change", { change_id: rest });
        show("Omarchy · Undo Config Change", JSON.stringify(res, null, 2), res.ok === false ? "error" : "success");
        return;
      }
      if (sub === "crashes") {
        const cr = await runEnvTool("diagnose_crashes", { target: rest, backtrace: Boolean(rest) });
        show("Omarchy · Crash Diagnostics", JSON.stringify(cr, null, 2));
        return;
      }
      throw new Error("Usage: /omarchy [profile|commands [q]|keybindings [q]|ref [topic]|changes|undo [id]|crashes [target]]");
    }),
  });

  pi.on("resources_discover", async () => ({
    themePaths: HERALD_THEME_FILES.map((name) => join(_extensionDir, name)),
  }));

  pi.on("before_agent_start", async (event, _ctx) => {
    let fleetContext = "";
    try {
      const fleetRes = await request("/fleet/context");
      if (fleetRes?.context) {
        fleetContext = `\n[Device & SSH Fleet Context]\n${fleetRes.context}\n`;
      }
    } catch {
      // Best-effort
    }

    const heraldInstructions = [
      "You are Herald, an expert AI software engineering platform, autonomous harness, and unified model router.",
      "You operate as an interactive coding environment, pair programmer, conversational partner, and tool/MCP execution platform.",
      "",
      "CORE CAPABILITIES:",
      "1. Software Engineering: Read, write, edit, search, test, debug, and architect code across all languages and frameworks.",
      "2. Shell & Tool Execution: Run local commands in bash, inspect directories, manage git, and execute MCP tools.",
      "3. Remote Fleet & Server Operations: Check out and manage services, Docker containers, and systems on remote nodes in your network using SSH and network commands via bash.",
      "4. Unified Model Routing: Intelligently route requests across local models (LM Studio, Ollama), CLI subscriptions (Claude, Codex, Antigravity), cloud APIs, and browser sessions.",
      "5. Multi-Model Coordination: Coordinate multi-model workflows and task delegation via herald_delegate.",
      "6. Ultimate Assistant Integration: You are connected to the user's Ultimate Assistant backend (`herald_assistant_agent` and shared MCP tools for memory, tasks, calendar, email, canvas, browser, skills, home, and desktop control). Ultimate Assistant's voice (SUPER+A), text (SUPER+ALT+A), overlay canvas, and phone app remain the user's primary daily assistant interfaces, while you (Herald Pi) serve as the power-user terminal/coding interface synchronized with the same backend.",
      "7. Omarchy Linux Mastery (KianArch): When configuring or debugging the user's Arch + Hyprland 0.56 Lua + Quickshell desktop, ALWAYS respect Omarchy architecture: never edit `/usr/share/omarchy/` (read-only package files); edit `~/.config/hypr/*.lua`, `~/.config/omarchy/shell.json`, or `~/.config/omarchy/themes/<name>/` via `herald_write_environment_file` / `herald_edit_environment_file` (which create automatic rollback backups and run `hyprctl reload && hyprctl configerrors`). Use `herald_environment_profile`, `herald_omarchy_commands`, `herald_omarchy_keybindings`, `herald_omarchy_reference`, and `herald_diagnose_crashes` for authoritative inspection.",
      "",
      "OPERATIONAL & TOOL GUIDELINES:",
      "- TASK TRACKING CHECKLIST: On multi-step goals, complex refactors, or multi-phase coding tasks, ALWAYS call `herald_task_track` first to define your planned task checklist. As you complete each step, call `herald_task_track` with `status: \"completed\"` to visually check off progress for the user.",
      "- ONE-SHOT PROBLEM SOLVING: Drive directly to resolution without babying or asking the user for trivial permissions. Plan, inspect, edit, and verify within the same autonomous turn. When a tool fails, adapt your command immediately (e.g. quote sanitization or alternative tool) and keep going until the goal is 100% achieved.",
      "- FLEET & REMOTE EXECUTION: Use configured SSH aliases from the Device & SSH Fleet Context to run commands against remote nodes (e.g. `ssh <alias> \"command\"` or `ssh <alias> dir`). Never run remote-only paths directly in the local shell.",
      "- Shell Environment: When running local commands on Windows, write PowerShell commands wrapped in `powershell -Command \"...\"` or use cross-platform tools (e.g. `python`, `git`, `ssh`) so they execute cleanly across bash and PowerShell.",
      "- Remote Discovery: Run real discovery commands against reachable fleet nodes.",
      "- If a command or tool call fails with an error, adapt your approach immediately: do NOT repeat the exact same failed command.",
      "- When greeted or asked about what you are / what you can do, respond directly and clearly as Herald. Summarize your capabilities concisely and offer concrete ways to assist.",
      "- Be technical, direct, helpful, and concise.",
      fleetContext,
    ].filter(Boolean).join("\n");

    const existingPrompt = event.systemPrompt || "";
    if (existingPrompt.includes("You are Herald")) {
      return;
    }
    return {
      systemPrompt: `${heraldInstructions}\n\n${existingPrompt}`,
    };
  });

  let activeBackend = "";
  let lastDurationMs: number | null = null;
  let turnStartTime = 0;
  let timerInterval: any = null;

  async function updateActiveBackend(ctx?: any) {
    try {
      const status = await request("/route/status");
      if (status?.last_backend) {
        activeBackend = status.last_backend;
        lastDurationMs = status.last_duration_ms;
        if (ctx?.ui) {
          ctx.ui.setStatus("herald-route", `${routeLabel} (${activeBackend})`);
          ctx.ui.requestRender?.();
        }
      }
    } catch {
      // Best-effort
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    turnStartTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (ctx?.ui && turnStartTime > 0) {
        const elapsed = ((Date.now() - turnStartTime) / 1000).toFixed(1);
        ctx.ui.setWorkingMessage(`Herald [${routeLabel}] reasoning & executing… (${elapsed}s)`);
      }
    }, 500);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    turnStartTime = 0;
    await updateActiveBackend(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    turnStartTime = 0;
    await updateActiveBackend(ctx);
  });

  pi.on("tool_call_end", async (_event, ctx) => {
    await updateActiveBackend(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (event.model.provider !== "herald") return;
    routeLabel = event.model.id;
    activeBackend = "";
    ctx.ui.setStatus("herald-route", `mode ${routeLabel}`);
    ctx.ui.setTitle(`Herald — ${routeLabel} — ${scopeLabel}`);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    eventStreamAbort?.abort();
    eventStreamAbort = new AbortController();
    void consumeEventStream(ctx, eventStreamAbort.signal);
    routeLabel = ctx.model?.id || routeLabel;
    ctx.ui.setTitle(`Herald — ${routeLabel} — ${scopeLabel}`);
    const themeResult = ctx.ui.setTheme("herald");
    if (!themeResult.success) {
      ctx.ui.notify(`Herald theme did not load: ${themeResult.error || "unknown error"}`, "warning");
    }
    ctx.ui.setWorkingMessage("Herald is routing, reasoning, and executing…");
    ctx.ui.setWorkingIndicator({
      frames: ["◇", "◈", "◆", "◈"].map((frame) => ctx.ui.theme.fg("accent", frame)),
      intervalMs: 140,
    });
    ctx.ui.setStatus("herald-router", routerOnline ? "router online" : "router offline");
    ctx.ui.setStatus("herald-route", `route ${routeLabel}`);
    ctx.ui.setStatus("herald-scope", scopeLabel);

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const rule = "─".repeat(Math.max(8, width - 2));
        const title = theme.fg("accent", "  HERALD") + theme.fg("muted", "  MODELS, TOOLS & AGENTS · ONE ROUTER");
        const backendBadge = activeBackend
          ? theme.fg("accent", ` [${activeBackend}${lastDurationMs != null ? ` · ${(lastDurationMs / 1000).toFixed(1)}s` : ""}]`)
          : "";
        const state = `${theme.fg(routerOnline ? "success" : "error", routerOnline ? "● ONLINE" : "● OFFLINE")}  ` +
          `${theme.fg(modelTone(routeLabel), routeLabel)}${backendBadge}  ${theme.fg("dim", "·")}  ${theme.fg("muted", scopeLabel)}`;
        const hint = theme.fg("dim", "  /help commands   /model behavior   Ctrl+P models   Ctrl+L expand tools");
        return [theme.fg("borderAccent", rule), title, `  ${state}`, hint, theme.fg("borderMuted", rule)];
      },
      invalidate() {},
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const usage = ctx.getContextUsage();
          const branch = footerData.getGitBranch();
          const backendPart = activeBackend ? ` [${activeBackend}]` : "";
          const left = theme.fg(modelTone(routeLabel), `◆ ${routeLabel}${backendPart}`) + theme.fg("dim", `  ${scopeLabel}`);
          const context = usage?.percent == null ? "context —" : `context ${usage.percent.toFixed(0)}%`;
          const rightText = `${branch ? `${branch}  ` : ""}${context}  ${routerOnline ? "router ●" : "router ○"}`;
          const right = theme.fg(routerOnline ? "muted" : "error", rightText);
          const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(left + padding + right, width)];
        },
      };
    });
  });

  pi.on("session_shutdown", async () => {
    eventStreamAbort?.abort();
    eventStreamAbort = null;
  });
}
