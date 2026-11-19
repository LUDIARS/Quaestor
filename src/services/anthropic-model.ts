import { resolveModel } from "@ludiars/one-shot";
import { contract } from '../contracts/contract-runtime.js'; /* augur-inject:import:fbd20ba6 */
import augurContract_64762ad8 from '../contracts/anthropic-model.contract.js'; /* augur-inject:contract-predicate:1210f9de */

/** The Anthropic API requires a concrete ID even when Claude Code can accept an alias. */
export function resolveAnthropicModel(requested?: string): string {
  const model = resolveModel(requested ?? "haiku", "claude");
  if (!model.startsWith("claude-")) throw new Error(`model_role_unresolved:${model}`);
  return model;
}
// @ts-expect-error augur-inject
resolveAnthropicModel = contract(resolveAnthropicModel, { ...augurContract_64762ad8, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/services/anthropic-model.ts:4', rule: 'contract-wrap', id: '64762ad8' }); /* augur-inject:contract-wrap:64762ad8 */
