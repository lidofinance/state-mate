import * as YAML from "yaml";

import { ADDRESS_OR_HASH_RE, pairKeyToString, SiblingSpec } from "./sibling-delegation";

const INPUTS_INFIX = ".inputs";
// The two groups of a `.inputs` file, split by AUTHORSHIP:
//   `config`    — project-chosen, configurable values (knobs): any scalar or array, no value check.
//   `externals` — fixed third-party / external facts: addresses (validated) plus `chainId` (numeric).
const INPUTS_SECTIONS = ["config", "externals"] as const;

/**
 * Validate the `.inputs` entries and collect their labels. The engine has already checked that the
 * file holds only `config:`/`externals:` sections; this enforces that every entry carries an `&label`
 * anchor and that no label is duplicated. `config` entries may be any anchored scalar or array (no
 * value check); `externals` entries must be anchored scalars whose string values are valid
 * addresses/hashes — a chainId-style non-negative integer (e.g. `&chainId 560048`) is exempt.
 */
function collectInputsLabels(document: YAML.Document): Set<string> {
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
      // `config` entries may be scalars or arrays — a map has no representation in the schema's
      // `config` section, so rejecting it here beats a confusing schema error after composing.
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
      // `externals` values must be a valid address/hash, EXCEPT a chainId-style non-negative decimal
      // integer — written either unquoted (`560048`, a bigint under `intAsBigInt`) or quoted
      // (`"560048"`, the convention existing configs use for chainId). Everything else is
      // address-checked, so REPLACEME, env-var names, `null`, booleans, floats, negatives, and an
      // unquoted hex address (which YAML parses to a non-address bigint with `format: "HEX"`) are
      // all rejected — matching the strictness of the `.deployed` address check.
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
        throw new Error(`duplicate label &${node.anchor} in the .inputs file`);
      }
      labels.add(node.anchor);
    }
  }
  return labels;
}

/** The `.inputs` delegation: project-chosen `config:` values and fixed external `externals:` facts. */
export const INPUTS_SPEC: SiblingSpec = {
  infix: INPUTS_INFIX,
  optionName: "--inputs",
  fileLabel: "the .inputs file",
  ownedSectionKeys: [...INPUTS_SECTIONS],
  collectLabels: collectInputsLabels,
};
