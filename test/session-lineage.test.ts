import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSubagentLineage,
  attachParentSession,
  SUBAGENT_LINEAGE_CUSTOM_TYPE,
} from "../src/session-lineage.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("persisted subagent session lineage", () => {
  it("writes one child file with Pi parentSession and nested lineage metadata", () => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-subagents-lineage-"));
    const sessionDir = join(tempDir, "sessions");
    const manager = SessionManager.create(tempDir, sessionDir);

    attachParentSession(manager, "/sessions/parent.jsonl");
    appendSubagentLineage(manager, "child-agent", "reviewer", {
      parentSessionId: "parent-session",
      parentSessionFile: "/sessions/parent.jsonl",
      rootSessionId: "root-session",
      rootSessionFile: "/sessions/root.jsonl",
      parentAgentId: "parent-agent",
      depth: 2,
    });
    // Pi intentionally delays creating a persisted file until an assistant
    // message exists; this flushes the header and the earlier lineage entry.
    manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as any);

    const files = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const entries = readFileSync(join(sessionDir, files[0]), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries[0]).toMatchObject({
      type: "session",
      parentSession: "/sessions/parent.jsonl",
    });
    expect(entries[1]).toMatchObject({
      type: "custom",
      customType: SUBAGENT_LINEAGE_CUSTOM_TYPE,
      data: {
        schema: "pi-subagents.lineage.v1",
        role: "subagent",
        kind: "nested",
        depth: 2,
        session_id: manager.getSessionId(),
        session_file: manager.getSessionFile(),
        parent_session_id: "parent-session",
        parent_session_file: "/sessions/parent.jsonl",
        root_session_id: "root-session",
        root_session_file: "/sessions/root.jsonl",
        agent_id: "child-agent",
        agent_type: "reviewer",
        parent_agent_id: "parent-agent",
      },
    });
  });
});
