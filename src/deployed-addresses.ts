import * as YAML from "yaml";

import {
  ADDRESS_OR_HASH_RE,
  composeWithSiblings,
  deriveSiblingPath,
  isSiblingFileName,
  pairKeyToString,
  resolveSiblingFilePath,
  SiblingSpec,
} from "./sibling-delegation";

const DEPLOYED_INFIX = ".deployed";

export type DeployedComposeResult = {
  document: unknown;
  labels: string[];
};

/**
 * Validate the deployed-addresses file and collect its labels. Enforces that the file contains only
 * a `deployed:` section, that every address is a scalar carrying an `&label` anchor, and that no
 * label is duplicated.
 */
function collectDeployedLabels(deployedDocument: YAML.Document): Set<string> {
  if (!YAML.isMap(deployedDocument.contents)) {
    // eslint-disable-next-line unicorn/prefer-type-error -- user-facing config-validation error, not a programmer TypeError
    throw new Error("the .deployed file must be a mapping with a `deployed:` section");
  }
  const extraKeys = deployedDocument.contents.items
    .map((pair) => pairKeyToString(pair.key))
    .filter((key) => key && key !== "deployed");
  if (extraKeys.length > 0) {
    throw new Error(
      `the .deployed file may only contain a \`deployed:\` section, but also has: ${extraKeys.join(", ")}`,
    );
  }

  const deployedNode = deployedDocument.get("deployed");
  if (!YAML.isMap(deployedNode)) {
    // eslint-disable-next-line unicorn/prefer-type-error -- user-facing config-validation error, not a programmer TypeError
    throw new Error("the .deployed file must contain a `deployed:` mapping");
  }

  const labels = new Set<string>();
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
      if (labels.has(item.anchor)) {
        throw new Error(`duplicate label &${item.anchor} in the .deployed file`);
      }
      labels.add(item.anchor);
    }
  }
  return labels;
}

/** The `.deployed` delegation: a single `deployed:` section of labeled (20- or 32-byte) addresses. */
export const DEPLOYED_SPEC: SiblingSpec = {
  infix: DEPLOYED_INFIX,
  optionName: "--deployed",
  fileLabel: "the .deployed file",
  ownedSectionKeys: ["deployed"],
  collectLabels: collectDeployedLabels,
  assertMainClean: (presentKeys) => {
    if (presentKeys.has("deployed")) {
      throw new Error(
        "the main config still has a `deployed:` section; move every address to the .deployed file so " +
          "the main config holds only the wiring",
      );
    }
  },
};

/** Derive the conventional sibling path: `lido.yaml` -> `lido.deployed.yaml`. */
export function deriveDeployedSiblingPath(configPath: string): string {
  return deriveSiblingPath(configPath, DEPLOYED_INFIX);
}

/** True when the file is itself a `*.deployed.<ext>` file (so it must not be given its own sibling). */
export function isDeployedFileName(filePath: string): boolean {
  return isSiblingFileName(filePath, DEPLOYED_INFIX);
}

/**
 * Decide which deployed-addresses file to apply, or `null` for a standalone run.
 * An explicit `--deployed` path wins (and must be an existing file); otherwise the conventional
 * sibling is used only when it is a file. Throws on an explicit path that is missing or not a file.
 */
export function resolveDeployedFilePath(configPath: string, deployedArgument?: string): string | null {
  return resolveSiblingFilePath(configPath, DEPLOYED_SPEC, deployedArgument);
}

/**
 * Compose a main config (wiring only) with a separate deployed-addresses file (the sole source of
 * `&label` address anchors) — the "full delegation" model. Pure; throws on any violation. A thin
 * wrapper over the generic `composeWithSiblings` engine.
 */
export function composeWithDeployedAddresses(mainText: string, deployedText: string): DeployedComposeResult {
  const { document, labels } = composeWithSiblings(mainText, [{ text: deployedText, spec: DEPLOYED_SPEC }]);
  return { document, labels: labels[0] };
}
