import * as YAML from "yaml";

import { ADDRESS_OR_HASH_RE, pairKeyToString, type SiblingSpec } from "./sibling-delegation";

const INPUTS_SECTIONS = ["config", "externals"] as const;

function collectInputsLabels(document: YAML.Document, fileLabel: string): Set<string> {
  const labels = new Set<string>();
  if (!YAML.isMap(document.contents)) {
    return labels; // unreachable: the engine has already rejected non-mapping files
  }
  for (const pair of document.contents.items) {
    const sectionKey = pairKeyToString(pair.key);
    if (!YAML.isSeq(pair.value)) {
      throw new Error(`\`${sectionKey}\` must be a list of labeled entries`);
    }
    const requireAddress = sectionKey === "externals";
    for (const item of pair.value.items) {
      const scalar = YAML.isScalar(item) ? item : null;
      // Reject maps here because the config schema only supports scalars and arrays.
      const node = scalar ?? (YAML.isSeq(item) ? item : null);
      if (requireAddress && !scalar) {
        throw new Error(`every entry under \`${sectionKey}\` must be a scalar address with an &label`);
      }
      if (!node) {
        throw new Error(`every entry under \`${sectionKey}\` must be a labeled scalar or array with an &label`);
      }
      if (!node.anchor) {
        const where = scalar ? `entry ${String(scalar.value)}` : `an entry`;
        throw new Error(`${where} under \`${sectionKey}\` has no &label anchor`);
      }
      // Decimal IDs are exempt from address validation, including quoted IDs. Check the YAML
      // format so unquoted hex addresses parsed as bigints cannot use that exemption.
      if (requireAddress && scalar) {
        const { value } = scalar;
        const isChainIdLikeInteger =
          (typeof value === "bigint" && value >= 0n && scalar.format == null) ||
          (typeof value === "string" && /^\d+$/.test(value));
        if (!isChainIdLikeInteger && !ADDRESS_OR_HASH_RE.test(String(value))) {
          throw new Error(`label &${node.anchor} is not a valid address: ${String(value)}`);
        }
      }
      if (labels.has(node.anchor)) {
        throw new Error(`duplicate label &${node.anchor} in ${fileLabel}`);
      }
      labels.add(node.anchor);
    }
  }
  return labels;
}

/** The `.inputs` delegation: project-chosen `config:` values and fixed external `externals:` facts. */
export const INPUTS_SPEC: SiblingSpec = {
  optionName: "--inputs",
  fileLabel: "the .inputs file",
  ownedSectionKeys: [...INPUTS_SECTIONS],
  collectLabels: collectInputsLabels,
};
