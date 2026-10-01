/** Independent response-boundary predicate for SPEC-MAIL-CRAWLER-006. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export default {
  post(result: number | null, receipt: unknown): true | string {
    const outer = object(receipt);
    const id = object(object(outer.message).message).id;
    const expected = outer.ok === true && outer.relayed === 1
      && typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
    return result === expected || "Only the nested Cc acceptance ID may be preserved";
  },
};
