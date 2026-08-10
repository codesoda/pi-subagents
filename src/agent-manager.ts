/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { SubagentLineageContext } from "./session-lineage.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
  lineage?: SubagentLineageContext;
}

interface QueueEntry {
  id: string;
  start: () => void;
  /** Settle any deferred queue-facing promise when the entry never starts. */
  cancel?: () => void;
}

export interface ResumeOptions {
  /** Run detached, returning the running/queued record immediately. */
  isBackground?: boolean;
  /** Description for this resumed turn. */
  description?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called when queued guidance has been folded into the effective prompt. */
  onPromptPrepared?: (effectivePrompt: string) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called at the end of each resumed agentic turn. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

export interface SpawnOptions {
  description: string;
  /** Caller-supplied session name; falls back to the agent config/type when omitted. */
  sessionName?: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Internal root-session propagation for nested launches. */
  lineageRootSessionId?: string;
  /** Internal root-session path propagation for nested launches. */
  lineageRootSessionFile?: string;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background spawns/resumes waiting to start. */
  private queue: QueueEntry[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      runGeneration: 0,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      runSettled: false,
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      maxSubagentDepth: options.maxSubagentDepth,
    };
    this.agents.set(id, record);

    // Snapshot lineage at invocation time. A queued child must retain the
    // session identity that launched it rather than reading a later live value.
    const parentSessionId = ctx.sessionManager?.getSessionId?.();
    const parentSessionFile = ctx.sessionManager?.getSessionFile?.();
    const lineage: SubagentLineageContext | undefined = parentSessionId
      ? {
          parentSessionId,
          parentSessionFile,
          rootSessionId: options.lineageRootSessionId ?? parentSessionId,
          rootSessionFile: options.lineageRootSessionFile ?? parentSessionFile,
          parentAgentId: options.parentAgentId,
          depth: options.depth ?? 1,
        }
      : undefined;
    const args: SpawnArgs = { pi, ctx, type, prompt, options, lineage };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, start: () => this.startAgent(id, record, args) });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options, lineage }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.runSettled = false;
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      sessionName: options.sessionName,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      signal: record.abortController!.signal,
      lineage,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        record.runSettled = true;

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        } else {
          this.runningBackground--;
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        record.runSettled = true;

        // Fire onComplete for foreground agents too — lifecycle symmetry.
        // Mark resultConsumed so the callback skips notifications (result returned inline).
        if (!options.isBackground) {
          record.resultConsumed = true;
          this.onComplete?.(record);
        } else {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming starts.
    this.onSpawned?.(id);
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        next.start();
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.runSettled = true;
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        next.cancel?.();
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    let id: string;
    try {
      // spawn() invokes onSpawned synchronously before returning. Restore the
      // shared hook immediately so unrelated concurrent spawns cannot inherit
      // this foreground caller's output/setup callback while its run is awaited.
      id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    } finally {
      this.onSpawned = prevOnSpawned;
    }
    const record = this.agents.get(id)!;
    await record.promise;
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   *
   * Foreground resumes preserve the historical await-and-return behavior.
   * Background resumes return the running/queued record immediately and settle
   * through the same lifecycle, notification, and concurrency paths as a
   * background spawn.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options: ResumeOptions = {},
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;
    if (record.status === "running" || record.status === "queued" || record.runSettled === false) {
      const state = record.runSettled === false && record.status === "stopped"
        ? "stopping"
        : record.status;
      throw new Error(`Agent "${id}" is already ${state}; it cannot be resumed concurrently.`);
    }

    const isBackground = options.isBackground === true;
    record.runGeneration = (record.runGeneration ?? 0) + 1;
    record.description = options.description ?? record.description;
    record.status = isBackground ? "queued" : "running";
    record.runSettled = false;
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.resultConsumed = !isBackground;
    record.abortController = new AbortController();

    const start = () => this.startResume(id, record, prompt, isBackground ? undefined : signal, options);
    if (isBackground && this.runningBackground >= this.maxConcurrent) {
      let settleQueued!: (value: string) => void;
      const queuedPromise = new Promise<string>((resolve) => { settleQueued = resolve; });
      record.promise = queuedPromise;
      this.queue.push({
        id,
        start: () => {
          start();
          const activePromise = record.promise;
          if (activePromise === queuedPromise) settleQueued("");
          else activePromise?.then(settleQueued, () => settleQueued(""));
        },
        cancel: () => settleQueued(""),
      });
      return record;
    }

    start();
    if (!isBackground) await record.promise;
    return record;
  }

  /** Start an immediate or queued resume against the existing AgentSession. */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ): void {
    const session = record.session;
    if (!session) throw new Error(`Agent "${id}" has no active session to resume.`);

    const isBackground = options.isBackground === true;
    record.status = "running";
    record.startedAt = Date.now();
    if (isBackground) this.runningBackground++;
    this.onStart?.(record);

    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      if (parentSignal.aborted) onParentAbort();
      else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
      }
    }

    const settle = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      if (isBackground) this.runningBackground--;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      if (isBackground) this.drainQueue();
    };

    const queuedGuidance = record.pendingSteers;
    record.pendingSteers = undefined;
    const effectivePrompt = queuedGuidance?.length
      ? `${prompt}\n\nAdditional guidance queued while this resumed run was waiting:\n${queuedGuidance.map(message => `- ${message}`).join("\n")}`
      : prompt;
    try { options.onPromptPrepared?.(effectivePrompt); } catch { /* transcript/setup callbacks are non-fatal */ }

    record.promise = resumeAgent(session, effectivePrompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTextDelta: options.onTextDelta,
      onTurnEnd: options.onTurnEnd,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: record.abortController?.signal,
    })
      .then((responseText) => {
        if (record.status !== "stopped") record.status = "completed";
        record.result = responseText;
        record.completedAt ??= Date.now();
        record.runSettled = true;
        settle();
        return responseText;
      })
      .catch((err) => {
        if (record.status !== "stopped") record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        record.runSettled = true;
        settle();
        return "";
      });
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      const queued = this.queue.filter(q => q.id === id);
      this.queue = this.queue.filter(q => q.id !== id);
      for (const entry of queued) entry.cancel?.();
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      record.status = "stopped";
      record.runSettled = true;
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || record.runSettled === false) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued" || record.runSettled === false) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued" || r.runSettled === false,
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      queued.cancel?.();
      if (record) {
        record.status = "stopped";
        record.runSettled = true;
        record.completedAt = Date.now();
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued" || r.runSettled === false)
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
