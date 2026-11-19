import { readRoleMap } from "@ludiars/one-shot";

export default {
  post(args: string[], schema: string): true | string {
    const expected = process.env.LUDIARS_ONESHOT_MODEL_LUNA || readRoleMap()?.codex?.luna;
    const hasPair = (flag: string, value: string): boolean =>
      args.some((arg, index) => arg === flag && args[index + 1] === value);
    if (!expected || !hasPair("--model", expected)) return "Codex requires the configured Luna ID";
    return (hasPair("--sandbox", "read-only") && hasPair("--output-schema", schema))
      || "The sandbox or output schema changed";
  },
};
