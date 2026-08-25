import * as YAML from "yaml";

import { ADDRESS_OR_HASH_RE, CollectedEntries, pairKeyToString, SiblingSpec } from "./sibling-delegation";

const DEPLOYED_INFIX = ".deployed";

/**
 * Validate the deployed-addresses entries and return their labeled entries. The engine has already
 * checked that the file holds only a `deployed:` section; this enforces that every address is a scalar
 * carrying an `&label` anchor, is a valid address/hash, and that no label is duplicated. Values and
 * sections are recorded for the shared `SiblingSpec.collect` contract; `.deployed` has no overlay, so
 * they go unread today, but keeping them truthful lets one collector serve every sibling role.
 */
function collectDeployedEntries(deployedDocument: YAML.Document, fileLabel: string): CollectedEntries {
  const deployedNode = deployedDocument.get("deployed");
  if (!YAML.isMap(deployedNode)) {
    // eslint-disable-next-line unicorn/prefer-type-error -- user-facing config-validation error, not a programmer TypeError
    throw new Error("the .deployed file must contain a `deployed:` mapping");
  }

  const entries: CollectedEntries = new Map();
  for (const pair of deployedNode.items) {
    const sectionKey = pairKeyToString(pair.key, "?");
    if (!YAML.isSeq(pair.value)) {
      throw new Error(`\`deployed.${sectionKey}\` must be a list of labeled addresses`);
    }
    for (const item of pair.value.items) {
      if (!YAML.isScalar(item)) {
        throw new Error(`every entry under \`deployed.${sectionKey}\` must be a scalar address with an &label`);
      }
      const value = String(item.value);
      if (!item.anchor) {
        throw new Error(`address ${value} under \`deployed.${sectionKey}\` has no &label anchor`);
      }
      if (!ADDRESS_OR_HASH_RE.test(value)) {
        throw new Error(`label &${item.anchor} is not a valid address: ${value}`);
      }
      if (entries.has(item.anchor)) {
        throw new Error(`duplicate label &${item.anchor} in ${fileLabel}`);
      }
      entries.set(item.anchor, { value, section: sectionKey });
    }
  }
  return entries;
}

/** The `.deployed` delegation: a single `deployed:` section of labeled (20- or 32-byte) addresses. */
export const DEPLOYED_SPEC: SiblingSpec = {
  infix: DEPLOYED_INFIX,
  optionName: "--deployed",
  fileLabel: "the .deployed file",
  ownedSectionKeys: ["deployed"],
  collect: collectDeployedEntries,
};
