import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNeedsConfig,
  getSetupFields,
  submitSetupConfig,
} from "../src/bun/setup";

describe("submitSetupConfig validation", () => {
  it("succeeds for valid inputs and writes files", () => {
    const result = submitSetupConfig({
      provider: "kimi-coding",
      model: "kimi-k2.5",
      api_key: "sk-xxxx",
    });
    expect(result.success).toBe(true);
    expect(result.writtenTo.length).toBeGreaterThan(0);
  });

  it("fails when provider is missing", () => {
    const result = submitSetupConfig({
      provider: "",
      model: "model-x",
      api_key: "key",
    });
    expect(result.success).toBe(false);
    const err = result.errors?.find((e) => e.fieldId === "provider");
    expect(err).toBeDefined();
  });

  it("fails when api_key is empty", () => {
    const result = submitSetupConfig({
      provider: "openai",
      model: "gpt-4",
      api_key: "",
    });
    expect(result.success).toBe(false);
    const err = result.errors?.find((e) => e.fieldId === "api_key");
    expect(err).toBeDefined();
  });
});

describe("getSetupFields", () => {
  it("returns fields and values", () => {
    const { fields, values } = getSetupFields();
    expect(fields.length).toBeGreaterThan(0);
    expect(typeof values).toBe("object");
  });
});

describe("checkNeedsConfig", () => {
  it("returns a boolean", () => {
    expect(typeof checkNeedsConfig()).toBe("boolean");
  });
});
