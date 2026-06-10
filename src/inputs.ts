import * as YAML from "yaml";

import {
  ADDRESS_OR_HASH_RE,
  composeWithSiblings,
  pairKeyToString,
  resolveSiblingFilePath,
  SiblingSpec,
} from "./sibling-delegation";

const INPUTS_INFIX = ".inputs";
// The two groups of a `.inputs` file, split by AUTHORSHIP:
//   `config`    — project-chosen, configurable values (knobs): any scalar or array, no value check.
//   `externals` — fixed third-party / external facts: addresses (validated) plus `chainId` (numeric).
const INPUTS_SECTIONS = ["config", "externals"] as const;
type InputsSection = (typeof INPUTS_SECTIONS)[number];

function isInputsSection(key: string): key is InputsSection {
  return (INPUTS_SECTIONS as readonly string[]).includes(key);
}

export type InputsComposeResult = {
  document: unknown;
  labels: string[];
};

/**
 * Validate the `.inputs` file and collect its labels. Enforces that the file contains only `config:`
 * and/or `externals:` sections, that every entry carries an `&label` anchor, and that no label is
 * duplicated. `config` entries may be any anchored scalar or collection (no value check); `externals`
 * entries must be anchored scalars whose string values are valid addresses/hashes — numeric values
 * (e.g. `&chainId 560048`) are exempt from the address check.
 */
function collectInputsLabels(document: YAML.Document): Set<string> {
  if (!YAML.isMap(document.contents)) {
    // eslint-disable-next-line unicorn/prefer-type-error -- user-facing config-validation error, not a programmer TypeError
    throw new Error("the .inputs file must be a mapping with `config:` and/or `externals:` section(s)");
  }
  const topLevelKeys = document.contents.items.map((pair) => pairKeyToString(pair.key)).filter(Boolean);
  const extraKeys = topLevelKeys.filter((key) => !isInputsSection(key));
  if (extraKeys.length > 0) {
    throw new Error(
      `the .inputs file may only contain \`config:\` and/or \`externals:\` section(s), but also has: ${extraKeys.join(", ")}`,
    );
  }
  // Parity with `.deployed`, which requires its `deployed:` section to be present: a `.inputs` file
  // is auto-loaded only when it exists, so a section-less one (e.g. an empty `{}` map) is a mistake,
  // not a no-op — reject it instead of silently contributing zero anchors.
  if (!topLevelKeys.some((key) => isInputsSection(key))) {
    throw new Error("the .inputs file must contain a `config:` and/or `externals:` section");
  }

  const labels = new Set<string>();
  for (const pair of document.contents.items) {
    const sectionKey = pairKeyToString(pair.key);
    if (!isInputsSection(sectionKey)) {
      continue;
    }
    if (!YAML.isSeq(pair.value)) {
      throw new Error(`\`${sectionKey}\` must be a list of labeled entries`);
    }
    const requireAddress = sectionKey === "externals";
    for (const item of pair.value.items) {
      const scalar = YAML.isScalar(item) ? item : null;
      const node = scalar ?? (YAML.isCollection(item) ? item : null);
      if (requireAddress && !scalar) {
        throw new Error(`every entry under \`${sectionKey}\` must be a scalar address with an &label`);
      }
      if (!node) {
        throw new Error(`every entry under \`${sectionKey}\` must be a labeled value with an &label`);
      }
      if (!node.anchor) {
        const where = scalar ? `entry ${String(scalar.value)}` : `an entry`;
        throw new Error(`${where} under \`${sectionKey}\` has no &label anchor`);
      }
      // `externals` values must be a valid address/hash, EXCEPT a chainId-style decimal integer —
      // written either unquoted (`560048`) or quoted (`"560048"`, the convention existing configs use
      // for chainId). Everything else is address-checked, so REPLACEME, env-var names, `null`, booleans,
      // and an unquoted hex address (which YAML parses to a non-address bigint with `format: "HEX"`) are
      // all rejected — matching the strictness of the `.deployed` address check.
      if (requireAddress && scalar) {
        const { value } = scalar;
        const isChainIdLikeInteger =
          ((typeof value === "bigint" || typeof value === "number") && scalar.format == null) ||
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
  assertMainClean: (presentKeys) => {
    const present = INPUTS_SECTIONS.filter((key) => presentKeys.has(key));
    if (present.length > 0) {
      throw new Error(
        `the main config still has ${present.map((key) => `\`${key}:\``).join(" / ")} section(s); ` +
          "move every value to the .inputs file so the main config holds only the wiring",
      );
    }
  },
};

/**
 * Decide which `.inputs` file to apply, or `null` for a standalone run. An explicit `--inputs` path
 * wins (and must be an existing file); otherwise the conventional sibling is used only when it is a
 * file. Throws on an explicit path that is missing or not a file.
 */
export function resolveInputsFilePath(configPath: string, inputsArgument?: string): string | null {
  return resolveSiblingFilePath(configPath, INPUTS_SPEC, inputsArgument);
}

/**
 * Compose a main config (wiring only) with a separate `.inputs` file (the sole source of its
 * `config:`/`externals:` anchors). Pure; throws on any violation. A thin wrapper over the generic
 * `composeWithSiblings` engine.
 */
export function composeWithInputs(mainText: string, inputsText: string): InputsComposeResult {
  const { document, labels } = composeWithSiblings(mainText, [{ text: inputsText, spec: INPUTS_SPEC }]);
  return { document, labels: labels[0] };
}
