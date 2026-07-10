import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";

let cwd: string;
let manager: NestedAgentManager;
let records: Map<string, any>;
let spawn: ReturnType<typeof vi.fn>;
let spawnAndWait: ReturnType<typeof vi.fn>;

function writeAgent(name: string, extra = "") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${extra}---\n${name}\n`);
}

function ctx() {
  return {
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  } as any;
}

function tools(allowedSubagents?: string[], depth = 1, maxSubagentDepth = 2) {
  return createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId: "parent-1",
    depth,
    maxSubagentDepth,
    allowedSubagents,
  });
}

async function execute(tool: any, params: Record<string, unknown>) {
  return tool.execute("call-1", params, undefined, undefined, ctx());
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nested-tools-test-"));
  writeAgent("scout");
  writeAgent("reviewer");
  registerAgents(loadCustomAgents(cwd));
  records = new Map();
  spawn = vi.fn((_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    records.set(id, { id, type, status: "running", parentAgentId: options.parentAgentId });
    return id;
  });
  spawnAndWait = vi.fn(async (_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    const record = { id, type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
    records.set(id, record);
    return { id, record };
  });
  manager = {
    spawn,
    spawnAndWait,
    getRecord: (id: string) => records.get(id),
    resume: vi.fn(),
  } as any;
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("child-safe nested Agent tool", () => {
  it("allows any enabled agent when allowed_subagents is omitted", async () => {
    const [agent] = tools(undefined);
    const result = await execute(agent, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "reviewer", "Review it",
      expect.objectContaining({ depth: 2, parentAgentId: "parent-1", maxSubagentDepth: 2 }),
    );
  });

  it("enforces a narrow allowlist and treats an empty list as allow none", async () => {
    const [limited] = tools(["scout"]);
    const denied = await execute(limited, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not allowed");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const [empty] = tools([]);
    const none = await execute(empty, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("Allowed: none");
  });

  it("blocks delegation at the inherited depth cap", async () => {
    const [agent] = tools(undefined, 2, 2);
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth=2, max=2");
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("rejects unknown or disabled nested agent types instead of falling back", async () => {
    const [agent] = tools(undefined);
    const result = await execute(agent, {
      subagent_type: "missing",
      description: "missing agent",
      prompt: "Do work",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown or disabled");
  });

  it("supports background nested agents and scopes result access to the owner", async () => {
    const [agent, getResult] = tools(["scout"]);
    const launched = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      run_in_background: true,
    });
    expect(launched.content[0].text).toContain("child-1");
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "scout", "Find them",
      expect.objectContaining({ isBackground: true, depth: 2, parentAgentId: "parent-1" }),
    );

    const own = await execute(getResult, { agent_id: "child-1" });
    expect(own.isError).toBe(false);

    records.set("foreign", { id: "foreign", status: "completed", result: "secret", parentAgentId: "other" });
    const foreign = await execute(getResult, { agent_id: "foreign" });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0].text).toContain("not owned");
  });

  it("propagates a target agent's tighter depth cap", async () => {
    writeAgent("tight", "max_subagent_depth: 1\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools(undefined, 1, 3);
    const result = await execute(agent, {
      subagent_type: "tight",
      description: "tight child",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "tight", "Do work",
      expect.objectContaining({ depth: 2, maxSubagentDepth: 1 }),
    );
  });
});
