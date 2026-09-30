export type DatasetAclDecisionInput = {
  effect: "ALLOW" | "DENY";
  matches: boolean;
};

/** Dataset ACLs are default-deny and an explicit matching DENY always wins. */
export function resolveDatasetAcl(inputs: Iterable<DatasetAclDecisionInput>) {
  let allowed = false;
  for (const input of inputs) {
    if (!input.matches) continue;
    if (input.effect === "DENY") return false;
    allowed = true;
  }
  return allowed;
}
