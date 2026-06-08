import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import * as YAML from "yaml";

import { printError, YAML_PARSE_OPTIONS, yamlBigintReviver } from "./common";
import { logErrorAndExit } from "./logger";

const DEPLOYED_INFIX = ".deployed";
// Values under `deployed:` are contract/implementation addresses (20-byte) — a 32-byte hash is also
// allowed for forward-compatibility. Role hashes and other constants live in the main config, so a
// strict check here catches typos / env-var names / REPLACEME that the schema's permissive
// EthereumString format (a trailing `.+` branch) would let through.
const DEPLOYED_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

export type DeployedComposeResult = {
  document: unknown;
  labels: string[];
};

/** Derive the conventional sibling path: `lido.yaml` -> `lido.deployed.yaml`. */
export function deriveDeployedSiblingPath(configPath: string): string {
  const extension = path.extname(configPath);
  const base = path.basename(configPath, extension);
  return path.join(path.dirname(configPath), `${base}${DEPLOYED_INFIX}${extension}`);
}

/** True when the file is itself a `*.deployed.<ext>` file (so it must not be given its own sibling). */
export function isDeployedFileName(filePath: string): boolean {
  const extension = path.extname(filePath);
  return path.basename(filePath, extension).endsWith(DEPLOYED_INFIX);
}

/** True only when `filePath` exists and is a regular file (not a directory). */
function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide which deployed-addresses file to apply, or `null` for a standalone run.
 * An explicit `--deployed` path wins (and must be an existing file); otherwise the conventional
 * sibling is used only when it is a file. Throws on an explicit path that is missing or not a file.
 */
export function resolveDeployedFilePath(configPath: string, deployedArgument?: string): string | null {
  if (deployedArgument) {
    const resolved = path.resolve(deployedArgument);
    if (!fs.existsSync(resolved)) {
      throw new Error(`The --deployed file was not found: ${deployedArgument}`);
    }
    if (!isExistingFile(resolved)) {
      throw new Error(`The --deployed path is not a file: ${deployedArgument}`);
    }
    return resolved;
  }
  if (isDeployedFileName(configPath)) {
    return null;
  }
  const sibling = deriveDeployedSiblingPath(path.resolve(configPath));
  return isExistingFile(sibling) ? sibling : null;
}

function assertNoParseErrors(document: YAML.Document, label: string) {
  if (document.errors.length > 0) {
    throw new Error(`Failed to parse ${label}:\n${document.errors.map((error) => error.message).join("\n")}`);
  }
}

/**
 * Parse `text` as a single YAML document, with a file-targeted error if it is empty or multi-document.
 * Does NOT assert the absence of parse errors — the main config legitimately has unresolved aliases
 * (its anchors live in the .deployed file); callers assert where appropriate.
 */
function parseSingleDocument(text: string, label: string): YAML.Document {
  const documents = YAML.parseAllDocuments(text, YAML_PARSE_OPTIONS);
  if (documents.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (documents.length > 1) {
    throw new Error(`${label} must be a single YAML document (found '---'/'...' document markers mid-file)`);
  }
  return documents[0];
}

/** The string form of a YAML mapping key (scalar keys only), or `fallback` for anything else. */
function pairKeyToString(key: unknown, fallback = ""): string {
  return YAML.isScalar(key) ? String(key.value) : fallback;
}

/** Throw with `description` listing the labels (as `&name`) that satisfy `isViolation`, if any. */
function rejectLabels(candidates: Iterable<string>, isViolation: (label: string) => boolean, description: string) {
  const violating = [...candidates].filter((label) => isViolation(label));
  if (violating.length > 0) {
    throw new Error(`${description}: ${violating.map((label) => `&${label}`).join(", ")}`);
  }
}

/**
 * Remove a leading `---` document-start marker and a trailing `...` document-end marker (each
 * allowing surrounding comments/blank lines), so the deployed-addresses file and the main config
 * can be concatenated into ONE YAML document — the only way native anchors/aliases resolve across
 * the two files. Mid-file markers are rejected earlier by `parseSingleDocument`.
 */
function stripDocumentMarkers(text: string): string {
  const lines = text.split("\n");
  const isInsignificant = (line: string) => line.trim() === "" || line.trim().startsWith("#");

  const firstSignificant = lines.findIndex((line) => !isInsignificant(line));
  if (firstSignificant !== -1 && lines[firstSignificant].trim() === "---") {
    lines.splice(firstSignificant, 1);
  }

  let lastSignificant = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!isInsignificant(lines[index])) {
      lastSignificant = index;
      break;
    }
  }
  if (lastSignificant !== -1 && lines[lastSignificant].trim() === "...") {
    lines.splice(lastSignificant, 1);
  }

  return lines.join("\n");
}

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
      if (!DEPLOYED_ADDRESS_RE.test(value)) {
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

/** Collect the anchors a document defines and the aliases it references, plus whether it has a `deployed:` key. */
function inspectMainDocument(mainDocument: YAML.Document): {
  anchors: Set<string>;
  aliases: Set<string>;
  hasDeployed: boolean;
} {
  const anchors = new Set<string>();
  const aliases = new Set<string>();
  const collectAnchor = (_key: unknown, node: YAML.Scalar | YAML.YAMLMap | YAML.YAMLSeq) => {
    if (node.anchor) anchors.add(node.anchor);
  };
  YAML.visit(mainDocument, {
    Scalar: collectAnchor,
    Map: collectAnchor,
    Seq: collectAnchor,
    Alias: (_key, node) => {
      aliases.add(node.source);
    },
  });
  const hasDeployed =
    YAML.isMap(mainDocument.contents) &&
    mainDocument.contents.items.some((pair) => pairKeyToString(pair.key) === "deployed");
  return { anchors, aliases, hasDeployed };
}

/**
 * Compose a main config (wiring only) with a separate deployed-addresses file (the sole source of
 * `&label` address anchors) — the "full delegation" model. Pure; throws on any violation.
 *
 * The main config holds only the wiring — `*label` aliases — and no `deployed:` section. The
 * `.deployed` file holds only the `deployed:` address book, with one `&label` per address. Because
 * YAML anchors can't be resolved across files, the two texts are concatenated (addresses first) and
 * parsed as a single document so every alias resolves natively. Before composing, four invariants
 * are enforced: every address is labeled, every label is referenced by the main config, the main
 * config has no `deployed:` section, and no label is duplicated or collides with a main anchor.
 */
export function composeWithDeployedAddresses(mainText: string, deployedText: string): DeployedComposeResult {
  const deployedDocument = parseSingleDocument(deployedText, "the .deployed file");
  assertNoParseErrors(deployedDocument, "the .deployed file");
  // The main config is parsed only for inspection here; on its own it has unresolved aliases (its
  // anchors live in the .deployed file). Real syntax errors are surfaced by the combined parse below.
  const mainDocument = parseSingleDocument(mainText, "the main config");

  const labels = collectDeployedLabels(deployedDocument);
  const { anchors: mainAnchors, aliases: mainAliases, hasDeployed } = inspectMainDocument(mainDocument);

  if (hasDeployed) {
    throw new Error(
      "the main config still has a `deployed:` section; move every address to the .deployed file so " +
        "the main config holds only the wiring",
    );
  }

  rejectLabels(
    labels,
    (label) => mainAnchors.has(label),
    "label(s) defined in both the main config and the .deployed file",
  );
  rejectLabels(
    labels,
    (label) => !mainAliases.has(label),
    "label(s) in the .deployed file are never referenced in the main config",
  );
  rejectLabels(
    mainAliases,
    (alias) => !labels.has(alias) && !mainAnchors.has(alias),
    "the main config references label(s) defined neither in it nor in the .deployed file",
  );

  const combinedText = `${stripDocumentMarkers(deployedText).replace(/\s*$/, "")}\n${stripDocumentMarkers(mainText)}`;
  const combinedDocument = YAML.parseDocument(combinedText, YAML_PARSE_OPTIONS);
  assertNoParseErrors(combinedDocument, "the combined config");

  return { document: combinedDocument.toJS({ reviver: yamlBigintReviver }), labels: [...labels] };
}

/** Read both files and compose them, converting any failure into a fatal, formatted exit. */
export function loadStateWithDeployedAddresses(configPath: string, deployedPath: string): DeployedComposeResult {
  try {
    const mainText = fs.readFileSync(path.resolve(configPath), "utf8");
    const deployedText = fs.readFileSync(path.resolve(deployedPath), "utf8");
    return composeWithDeployedAddresses(mainText, deployedText);
  } catch (error) {
    logErrorAndExit(`Failed to load deployed addresses from ${chalk.magenta(deployedPath)}:\n${printError(error)}`);
  }
}
