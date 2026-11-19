import { readRoleMap } from "@ludiars/one-shot";

export default {
  post(result: string, requested?: string): true | string {
    if (!result.startsWith("claude-")) return "The SDK requires a concrete Claude model ID";
    if (requested?.startsWith("claude-")) return result === requested || "The explicit ID changed";
    if (requested && requested !== "haiku") return true;
    const expected = process.env.LUDIARS_ONESHOT_MODEL_HAIKU || readRoleMap()?.claude?.haiku;
    return result === expected || "The SDK model differs from the configured Haiku ID";
  },
};
