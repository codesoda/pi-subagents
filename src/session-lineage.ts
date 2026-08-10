import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubagentType } from "./types.js";

/** Custom-entry discriminator used for durable pi-subagents session lineage. */
export const SUBAGENT_LINEAGE_CUSTOM_TYPE = "pi-subagents.lineage";
export const SUBAGENT_LINEAGE_SCHEMA = "pi-subagents.lineage.v1";

/** Immutable parent/root snapshot captured when a subagent is launched. */
export interface SubagentLineageContext {
  parentSessionId: string;
  parentSessionFile?: string;
  rootSessionId: string;
  rootSessionFile?: string;
  parentAgentId?: string;
  depth: number;
}

/** Persisted outside model context as a SessionManager custom entry. */
export interface PersistedSubagentLineage {
  schema: typeof SUBAGENT_LINEAGE_SCHEMA;
  role: "subagent";
  kind: "top_level" | "nested";
  depth: number;
  session_id: string;
  session_file: string | null;
  parent_session_id: string;
  parent_session_file: string | null;
  root_session_id: string;
  root_session_file: string | null;
  agent_id: string;
  agent_type: SubagentType;
  parent_agent_id: string | null;
}

/**
 * Pi versions supported by this fork expose NewSessionOptions on newSession(),
 * but not yet on SessionManager.create(). Replacing the constructor-created,
 * still-unflushed header here records parentSession without creating an orphan
 * file or inheriting any parent messages.
 */
export function attachParentSession(
  sessionManager: SessionManager,
  parentSessionFile: string | undefined,
): void {
  if (parentSessionFile) sessionManager.newSession({ parentSession: parentSessionFile });
}

export function appendSubagentLineage(
  sessionManager: SessionManager,
  agentId: string,
  agentType: SubagentType,
  lineage: SubagentLineageContext,
): PersistedSubagentLineage {
  const data: PersistedSubagentLineage = {
    schema: SUBAGENT_LINEAGE_SCHEMA,
    role: "subagent",
    kind: lineage.parentAgentId ? "nested" : "top_level",
    depth: lineage.depth,
    session_id: sessionManager.getSessionId(),
    session_file: sessionManager.getSessionFile() ?? null,
    parent_session_id: lineage.parentSessionId,
    parent_session_file: lineage.parentSessionFile ?? null,
    root_session_id: lineage.rootSessionId,
    root_session_file: lineage.rootSessionFile ?? null,
    agent_id: agentId,
    agent_type: agentType,
    parent_agent_id: lineage.parentAgentId ?? null,
  };
  sessionManager.appendCustomEntry(SUBAGENT_LINEAGE_CUSTOM_TYPE, data);
  return data;
}
