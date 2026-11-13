import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  appendAgentLaunchContext,
  PI_AGENT_LAUNCH_CONTEXT_ENTRY_TYPE,
} from "../src/agent-launch-context.js";

describe("generic agent launch context", () => {
  it("stores opaque metadata in an extension-readable custom entry", () => {
    const sessionManager = SessionManager.inMemory();
    const metadata = { fast: true, openai_mode: "ultrafast", nested: { enabled: false } };

    appendAgentLaunchContext(sessionManager, "reviewer", metadata);

    const entry = sessionManager.getEntries().find(
      (candidate) => candidate.type === "custom" && candidate.customType === PI_AGENT_LAUNCH_CONTEXT_ENTRY_TYPE,
    );
    expect(entry?.type).toBe("custom");
    if (entry?.type === "custom") {
      expect(entry.data).toEqual({ version: 1, agentType: "reviewer", metadata });
    }
  });

  it("does not add an entry when metadata is absent or empty", () => {
    const sessionManager = SessionManager.inMemory();
    const before = sessionManager.getEntries().length;

    appendAgentLaunchContext(sessionManager, "reviewer", undefined);
    appendAgentLaunchContext(sessionManager, "reviewer", {});

    expect(sessionManager.getEntries()).toHaveLength(before);
  });
});
