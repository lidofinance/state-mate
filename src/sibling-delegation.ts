import fs from "node:fs";
import path from "node:path";

import * as YAML from "yaml";

import { printError, YAML_PARSE_OPTIONS, yamlBigintReviver } from "./common";
import { logErrorAndExit } from "./logger";

// A contract/implementation address (20-byte) or a 32-byte hash (forward-compatibility). Shared by
// the value validation of delegated files (`.deployed`, the `.inputs` externals section): a strict
// check here catches typos / env-var names / REPLACEME that the schema's permissive EthereumString
// format (a trailing `.+` branch) would let through.
export const ADDRESS_OR_HASH_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

/**
 * Describes one kind of sibling "delegation" file (e.g. `.deployed`, `.inputs`). The generic engine
 * handles path resolution, document-marker stripping, the concat-then-parse composition, and the
 * cross-file invariants; each spec supplies the bits that differ: the filename infix, the human and
 * CLI labels, which top-level sections it owns (and which the main config must therefore NOT hold),
 * how to validate its own structure/values and collect its `&label` anchors, and how to report a
 * main config that still carries an owned section.
 */
export type SiblingSpec = {
  /** Filename infix inserted before the extension, e.g. `.deployed` -> `lido.deployed.yaml`. */
  infix: string;
  /** The CLI option that selects an explicit path, e.g. `--deployed` (used in resolution errors). */
  optionName: string;
  /** Human-facing label for this file, e.g. `the .deployed file` (used in error messages). */
  fileLabel: string;
  /** Top-level section keys this sibling owns; the main config must contain none of them. */
  ownedSectionKeys: string[];
  /** Validate the sibling document and return its `&label` anchors. Throws on any violation. */
  collectLabels: (document: YAML.Document) => Set<string>;
  /** Throw if the main config still contains any of this sibling's owned sections. */
  assertMainClean: (presentTopLevelKeys: Set<string>) => void;
};

export type ComposeResult = {
  document: unknown;
  /** Labels collected from each sibling, parallel to the input `siblings` array. */
  labels: string[][];
};

/** Derive the conventional sibling path: `lido.yaml` + `.deployed` -> `lido.deployed.yaml`. */
export function deriveSiblingPath(configPath: string, infix: string): string {
  const extension = path.extname(configPath);
  const base = path.basename(configPath, extension);
  return path.join(path.dirname(configPath), `${base}${infix}${extension}`);
}

/** True when the file is itself a `*<infix>.<ext>` file (so it must not be given its own sibling). */
export function isSiblingFileName(filePath: string, infix: string): boolean {
  const extension = path.extname(filePath);
  return path.basename(filePath, extension).endsWith(infix);
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
 * Decide which sibling file to apply, or `null` for a standalone run. An explicit `--<spec>` path
 * wins (and must be an existing file); otherwise the conventional sibling is used only when it is a
 * file. Throws on an explicit path that is missing or not a file.
 */
export function resolveSiblingFilePath(
  configPath: string,
  spec: SiblingSpec,
  explicitArgument?: string,
): string | null {
  if (explicitArgument) {
    const resolved = path.resolve(explicitArgument);
    if (!isExistingFile(resolved)) {
      throw new Error(
        fs.existsSync(resolved)
          ? `The ${spec.optionName} path is not a file: ${explicitArgument}`
          : `The ${spec.optionName} file was not found: ${explicitArgument}`,
      );
    }
    return resolved;
  }
  if (isSiblingFileName(configPath, spec.infix)) {
    return null;
  }
  const sibling = deriveSiblingPath(path.resolve(configPath), spec.infix);
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
 * (its anchors live in the sibling file); callers assert where appropriate.
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
export function pairKeyToString(key: unknown, fallback = ""): string {
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
 * allowing surrounding comments/blank lines), so the sibling file(s) and the main config can be
 * concatenated into ONE YAML document — the only way native anchors/aliases resolve across files.
 * Mid-file markers are rejected earlier by `parseSingleDocument`.
 */
function stripDocumentMarkers(text: string): string {
  const lines = text.split("\n");
  const isInsignificant = (line: string) => line.trim() === "" || line.trim().startsWith("#");

  const firstSignificant = lines.findIndex((line) => !isInsignificant(line));
  if (firstSignificant !== -1 && /^---(\s|$)/.test(lines[firstSignificant].trim())) {
    lines.splice(firstSignificant, 1);
  }

  let lastSignificant = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!isInsignificant(lines[index])) {
      lastSignificant = index;
      break;
    }
  }
  if (lastSignificant !== -1 && /^\.\.\.(\s|$)/.test(lines[lastSignificant].trim())) {
    lines.splice(lastSignificant, 1);
  }

  return lines.join("\n");
}

/** Collect the anchors a document defines, the aliases it references, and its top-level section keys. */
function inspectMainDocument(mainDocument: YAML.Document): {
  anchors: Set<string>;
  aliases: Set<string>;
  presentKeys: Set<string>;
} {
  const anchors = new Set<string>();
  const aliases = new Set<string>();
  const collectAnchor = (_key: unknown, node: YAML.Scalar | YAML.YAMLMap | YAML.YAMLSeq) => {
    if (node.anchor) anchors.add(node.anchor);
  };
  YAML.visit(mainDocument, {
    Scalar: collectAnchor,
    Collection: collectAnchor,
    Alias: (_key, node) => {
      aliases.add(node.source);
    },
  });
  const presentKeys = new Set<string>();
  if (YAML.isMap(mainDocument.contents)) {
    for (const pair of mainDocument.contents.items) {
      const key = pairKeyToString(pair.key);
      if (key) presentKeys.add(key);
    }
  }
  return { anchors, aliases, presentKeys };
}

/**
 * Compose a main config (wiring only) with one or more separate delegation files (the sole source of
 * their `&label` anchors) — the "full delegation" model. Pure; throws on any violation.
 *
 * The main config holds only the wiring — `*label` aliases — and none of the delegated sections.
 * Each sibling file holds only its own section(s), with one `&label` per delegated value. Because
 * YAML anchors can't be resolved across files, the texts are concatenated (sibling anchors first) and
 * parsed as a single document so every alias resolves natively. Before composing, the invariants are
 * enforced per sibling (every value labeled and valid; every label referenced by the main config; no
 * duplicate label) and across files (the main config has none of the delegated sections; no label
 * collides with a main anchor or with another sibling's label; every main alias resolves).
 */
export function composeWithSiblings(mainText: string, siblings: { text: string; spec: SiblingSpec }[]): ComposeResult {
  const collected = siblings.map(({ text, spec }) => {
    const document = parseSingleDocument(text, spec.fileLabel);
    assertNoParseErrors(document, spec.fileLabel);
    return { spec, labels: spec.collectLabels(document) };
  });

  // The main config is parsed only for inspection here; on its own it has unresolved aliases (its
  // anchors live in the sibling file(s)). Real syntax errors are surfaced by the combined parse below.
  const mainDocument = parseSingleDocument(mainText, "the main config");
  const { anchors: mainAnchors, aliases: mainAliases, presentKeys } = inspectMainDocument(mainDocument);

  // Full delegation: the main config must hold none of the delegated sections.
  for (const { spec } of siblings) {
    spec.assertMainClean(presentKeys);
  }

  // Per-sibling: no label collides with a main anchor or with another sibling's label; every label is
  // referenced by the main config.
  const seenLabels = new Set<string>();
  for (const { spec, labels } of collected) {
    rejectLabels(
      labels,
      (label) => mainAnchors.has(label),
      `label(s) defined in both the main config and ${spec.fileLabel}`,
    );
    rejectLabels(labels, (label) => seenLabels.has(label), `label(s) defined in more than one delegated file`);
    for (const label of labels) seenLabels.add(label);
    rejectLabels(
      labels,
      (label) => !mainAliases.has(label),
      `label(s) in ${spec.fileLabel} are never referenced in the main config`,
    );
  }

  // Every alias in the main config must resolve to some sibling label or a main anchor.
  const fileLabels = siblings.map(({ spec }) => spec.fileLabel).join(" / ");
  rejectLabels(
    mainAliases,
    (alias) => !seenLabels.has(alias) && !mainAnchors.has(alias),
    `the main config references label(s) defined neither in it nor in ${fileLabels}`,
  );

  const combinedText = [
    ...siblings.map(({ text }) => stripDocumentMarkers(text).replace(/\s*$/, "")),
    stripDocumentMarkers(mainText),
  ].join("\n");
  const combinedDocument = YAML.parseDocument(combinedText, YAML_PARSE_OPTIONS);
  assertNoParseErrors(combinedDocument, "the combined config");

  return {
    document: combinedDocument.toJS({ reviver: yamlBigintReviver }),
    labels: collected.map(({ labels }) => [...labels]),
  };
}

/** Read the main config and each sibling, then compose them, converting any failure into a fatal exit. */
export function loadStateWithSiblings(
  configPath: string,
  siblings: { path: string; spec: SiblingSpec }[],
): ComposeResult {
  let mainText: string;
  let siblingTexts: { text: string; spec: SiblingSpec }[];
  try {
    mainText = fs.readFileSync(path.resolve(configPath), "utf8");
    siblingTexts = siblings.map(({ path: siblingPath, spec }) => ({
      text: fs.readFileSync(path.resolve(siblingPath), "utf8"),
      spec,
    }));
  } catch (error) {
    return logErrorAndExit(`Failed to read config files:\n${printError(error)}`);
  }
  try {
    return composeWithSiblings(mainText, siblingTexts);
  } catch (error) {
    return logErrorAndExit(printError(error));
  }
}
