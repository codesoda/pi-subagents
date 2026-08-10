import type { Model } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ResumeOptions } from "./agent-manager.js";
import { getAgentConfig, getAvailableTypes, isValidType, registerAgents, resolveType } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord, IsolationMode, ThinkingLevel } from "./types.js";

export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;
const NESTED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

interface NestedSpawnOptions {
  description: string;
  sessionName?: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  lineageRootSessionId?: string;
  lineageRootSessionFile?: string;
}

export interface NestedAgentManager {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: NestedSpawnOptions,
  ): string;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<NestedSpawnOptions, "isBackground">,
  ): Promise<{ id: string; record: AgentRecord }>;
  getRecord(id: string): AgentRecord | undefined;
  resume(id: string, prompt: string, signal?: AbortSignal, options?: ResumeOptions): Promise<AgentRecord | undefined>;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** Root of the current subagent branch, propagated to nested children. */
  rootSessionId?: string;
  rootSessionFile?: string;
  /** undefined = unrestricted; [] = explicitly allow none. */
  allowedSubagents?: string[];
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function canonicalAllowedTypes(allowed: string[] | undefined): Set<string> | undefined {
  if (allowed === undefined) return undefined;
  const canonical = new Set<string>();
  for (const name of allowed) canonical.add(resolveType(name) ?? name);
  return canonical;
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

function formatRecord(record: AgentRecord): string {
  if (record.status === "error") return `Agent failed: ${record.error ?? "unknown error"}`;
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  return record.result?.trim() || record.error?.trim() || "No output.";
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  const allowed = canonicalAllowedTypes(context.allowedSubagents);
  const available = () => getAvailableTypes().filter(name => allowed === undefined || allowed.has(name));

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      name: Type.Optional(Type.String({ description: "Optional human-readable session name. The agent ID suffix is added automatically." })),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${available().join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      max_turns: Type.Optional(Type.Number({ minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      isolation: Type.Optional(Type.Literal("worktree")),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          return textResult(`Nested agent not found or not owned by this parent: "${params.resume}".`, true);
        }
        if (existing.status === "running" || existing.status === "queued" || existing.runSettled === false) {
          const state = existing.runSettled === false && existing.status === "stopped"
            ? "stopping"
            : existing.status;
          return textResult(`Nested agent "${params.resume}" is already ${state}.`, true);
        }
        // Frontmatter controls fresh launches; a resume backgrounds only when
        // this invocation explicitly asks for it.
        const resumeInBackground = params.run_in_background === true;
        try {
          const resumed = await context.manager.resume(
            params.resume,
            params.prompt,
            resumeInBackground ? undefined : signal,
            { isBackground: resumeInBackground, description: params.description },
          );
          if (!resumed) return textResult(`Failed to resume nested agent "${params.resume}".`, true);
          if (resumeInBackground) {
            return textResult(`Nested agent resumed in background. Agent ID: ${resumed.id}`);
          }
          return textResult(formatRecord(resumed), resumed.status === "error");
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err), true);
        }
      }

      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Refresh registry so newly added project agents are visible without restart.
      registerAgents(loadCustomAgents(ctx.cwd));
      const rawType = params.subagent_type;
      const resolvedType = resolveType(rawType);
      if (!resolvedType || !isValidType(resolvedType)) {
        return textResult(`Unknown or disabled nested agent type: "${rawType}".`, true);
      }
      const refreshedAllowed = canonicalAllowedTypes(context.allowedSubagents);
      if (refreshedAllowed !== undefined && !refreshedAllowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...refreshedAllowed].join(", ") || "none"}.`,
          true,
        );
      }

      const config = getAgentConfig(resolvedType);
      const invocation = resolveAgentInvocationConfig(config, params);
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (invocation.modelFromParams) return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }

      const childDepth = context.depth + 1;
      const childMaxDepth = Math.min(
        context.maxSubagentDepth,
        config?.maxSubagentDepth ?? context.maxSubagentDepth,
      );
      const options: NestedSpawnOptions = {
        description: params.description,
        sessionName: params.name,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: childMaxDepth,
        lineageRootSessionId: context.rootSessionId,
        lineageRootSessionFile: context.rootSessionFile,
      };

      if (invocation.runInBackground) {
        const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
          ...options,
          isBackground: true,
        });
        return textResult(`Nested agent started in background. Agent ID: ${id}`);
      }

      const { record } = await context.manager.spawnAndWait(
        context.pi,
        ctx,
        resolvedType,
        params.prompt,
        { ...options, signal },
      );
      return textResult(formatRecord(record), record.status === "error");
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (params.wait && record.promise) await record.promise;
      return textResult(formatRecord(record), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (record.status === "queued") {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      if (!record.session || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      await record.session.steer(params.message);
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  return [agentTool, resultTool, steerTool];
}
