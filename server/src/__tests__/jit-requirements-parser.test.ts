import { describe, it, expect } from "vitest";
import { parseJitRequirements } from "../services/jit-requirements-parser.js";

describe("parseJitRequirements", () => {
  it("parses a well-formed JIT Requirements section", () => {
    const desc = `## Overview
Some issue description.

## JIT Requirements
- target: work.int | role: agent-admin | reason: Deploy ticket verifier

## Acceptance Criteria
- stuff`;

    const result = parseJitRequirements(desc);
    expect(result).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy ticket verifier" },
    ]);
  });

  it("returns empty array when no section exists", () => {
    const desc = `## Overview
Just a normal issue without JIT requirements.`;
    expect(parseJitRequirements(desc)).toEqual([]);
  });

  it("handles multiple requirements", () => {
    const desc = `## JIT Requirements
- target: work.int | role: agent-admin | reason: Deploy ticket verifier
- target: pc.int | role: agent-admin | reason: Run integration tests
- target: staging.int | role: viewer | reason: Check logs`;

    const result = parseJitRequirements(desc);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      target: "work.int",
      role: "agent-admin",
      reason: "Deploy ticket verifier",
    });
    expect(result[1]).toEqual({
      target: "pc.int",
      role: "agent-admin",
      reason: "Run integration tests",
    });
    expect(result[2]).toEqual({
      target: "staging.int",
      role: "viewer",
      reason: "Check logs",
    });
  });

  it("skips malformed lines gracefully", () => {
    const desc = `## JIT Requirements
- target: work.int | role: agent-admin | reason: Deploy ticket verifier
- this line is malformed
- target: missing role and reason
- target: pc.int | role: agent-admin | reason: Run integration tests`;

    const result = parseJitRequirements(desc);
    expect(result).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy ticket verifier" },
      { target: "pc.int", role: "agent-admin", reason: "Run integration tests" },
    ]);
  });

  it("handles case-insensitive heading match", () => {
    const desc = `## jit requirements
- target: work.int | role: agent-admin | reason: Deploy`;

    expect(parseJitRequirements(desc)).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy" },
    ]);

    const desc2 = `## JIT REQUIREMENTS
- target: work.int | role: agent-admin | reason: Deploy`;

    expect(parseJitRequirements(desc2)).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy" },
    ]);
  });

  it("stops at the next heading", () => {
    const desc = `## JIT Requirements
- target: work.int | role: agent-admin | reason: Deploy
## Next Section
- target: should.not | role: parse | reason: This one`;

    const result = parseJitRequirements(desc);
    expect(result).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy" },
    ]);
  });

  it("returns empty array for null input", () => {
    expect(parseJitRequirements(null)).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(parseJitRequirements(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseJitRequirements("")).toEqual([]);
  });

  it("trims whitespace from parsed values", () => {
    const desc = `## JIT Requirements
- target:  work.int  | role:  agent-admin  | reason:  Deploy ticket verifier  `;

    const result = parseJitRequirements(desc);
    expect(result).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy ticket verifier" },
    ]);
  });

  it("handles section at end of string with no trailing heading", () => {
    const desc = `## JIT Requirements
- target: work.int | role: agent-admin | reason: Deploy`;

    const result = parseJitRequirements(desc);
    expect(result).toEqual([
      { target: "work.int", role: "agent-admin", reason: "Deploy" },
    ]);
  });
});
