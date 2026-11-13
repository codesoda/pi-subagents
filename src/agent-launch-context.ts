import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Shared custom-entry discriminator for metadata supplied when a Pi agent session is launched. */
export const PI_AGENT_LAUNCH_CONTEXT_ENTRY_TYPE = "pi:agent-launch-context";

/** Opaque frontmatter fields made available to extensions in a child session. */
export type AgentLaunchMetadata = Record<string, unknown>;

/**
 * Store launcher metadata on the child session before its extensions bind.
 * Custom entries are session state and do not enter the model prompt.
 */
export function appendAgentLaunchContext(
  sessionManager: Pick<SessionManager, "appendCustomEntry">,
  agentType: string,
  metadata: AgentLaunchMetadata | undefined,
): void {
  if (!metadata || Object.keys(metadata).length === 0) return;

  sessionManager.appendCustomEntry(PI_AGENT_LAUNCH_CONTEXT_ENTRY_TYPE, {
    version: 1,
    agentType,
    metadata,
  });
}

/**
 * Retain frontmatter fields this runtime does not interpret, so child extensions
 * can consume generic per-agent launch metadata without launcher-specific wiring.
 */
export function collectAgentLaunchMetadata(
  frontmatter: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
): AgentLaunchMetadata | undefined {
  const metadata = Object.fromEntries(
    Object.entries(frontmatter).filter(([key]) => !knownFields.has(key)),
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

