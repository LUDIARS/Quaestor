import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicOcrClient } from "../src/services/ocr-client.js";
import { SmartImporter } from "../src/services/smart-import.js";
import { stubModelRoleMap } from "./fixtures/model-role-map.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic { messages = { create }; },
}));

describe("Anthropic SDK model selection", () => {
  const image = Buffer.from("fixture");
  let cleanupRoleMap: () => void;

  beforeEach(() => {
    cleanupRoleMap = stubModelRoleMap({ claude: { haiku: "claude-test-haiku" } });
    create.mockResolvedValue({ content: [] });
  });

  afterEach(() => {
    create.mockReset();
    vi.unstubAllEnvs();
    cleanupRoleMap();
  });

  it("resolves Haiku for OCR and both smart import entry points", async () => {
    const ocr = new AnthropicOcrClient({ apiKey: "test" });
    const importer = new SmartImporter({ apiKey: "test" });
    await expect(ocr.extract(image, "image/png")).rejects.toThrow("no tool_use");
    await expect(importer.fromScreenshot(image, "image/png")).rejects.toThrow("no tool_use");
    await expect(importer.fromText("statement")).rejects.toThrow("no tool_use");
    expect(create.mock.calls.map(([request]) => request.model)).toEqual(Array(3).fill("claude-test-haiku"));
  });

  it("preserves explicit IDs and resolves the map again for an existing client", async () => {
    const importer = new SmartImporter({ apiKey: "test" });
    const ocr = new AnthropicOcrClient({ apiKey: "test", model: "claude-test-explicit" });
    const cleanupUpdatedMap = stubModelRoleMap({ claude: { haiku: "claude-test-updated" } });
    try {
      await expect(importer.fromText("statement")).rejects.toThrow("no tool_use");
      await expect(ocr.extract(image, "image/png")).rejects.toThrow("no tool_use");
      expect(create.mock.calls.map(([request]) => request.model)).toEqual(["claude-test-updated", "claude-test-explicit"]);
    } finally {
      cleanupUpdatedMap();
    }
  });

  it("fails before making a request when the map has no Haiku entry", async () => {
    const cleanupMissingMap = stubModelRoleMap({});
    try {
      await expect(new AnthropicOcrClient({ apiKey: "test" }).extract(image, "image/png"))
        .rejects.toThrow("model_role_unresolved:haiku");
      await expect(new SmartImporter({ apiKey: "test" }).fromText("statement"))
        .rejects.toThrow("model_role_unresolved:haiku");
      expect(create).not.toHaveBeenCalled();
    } finally {
      cleanupMissingMap();
    }
  });
});
