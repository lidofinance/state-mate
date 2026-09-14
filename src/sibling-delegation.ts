import fs from "node:fs";
import path from "node:path";

import * as YAML from "yaml";

import { printError, YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "./common";
import { logErrorAndExit } from "./logger";

// Enforce 20-byte addresses or 32-byte hashes; the schema also accepts placeholders such as REPLACEME.
export const ADDRESS_OR_HASH_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

/** Validation rules and section ownership for a sibling file such as `.deployed` or `.inputs`. */
export type SiblingSpec = {
  /** The CLI option that selects the file, e.g. `--deployed` (used in resolution errors). */
  optionName: string;
  /** Human-facing label for this file, e.g. `the .deployed file` (used in error messages). */
  fileLabel: string;
  /** Top-level section keys this sibling owns; it holds only these, the main config none of them. */
  ownedSectionKeys: string[];
  /**
   * Validate the sibling's sections/values and return its entry `&label` anchors. Throws on any
   * violation; `fileLabel` targets those errors at this file.
   */
  collectLabels: (document: YAML.Document, fileLabel: string) => Set<string>;
};

export type ComposeResult = {
  document: unknown;
  /** Labels collected from each sibling, parallel to the input `siblings` array. */
  labels: string[][];
};

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveExplicitFilePath(optionName: string, argument: string): string {
  const resolved = path.resolve(argument);
  if (!isExistingFile(resolved)) {
    throw new Error(
      fs.existsSync(resolved)
        ? `The ${optionName} path is not a file: ${argument}`
        : `The ${optionName} file was not found: ${argument}`,
    );
  }
  return resolved;
}

/** Select only explicitly supplied paths; an empty argument must fail rather than select a standalone run. */
export function resolveSiblingFilePath(spec: SiblingSpec, explicitArgument?: string): string | null {
  return explicitArgument === undefined ? null : resolveExplicitFilePath(spec.optionName, explicitArgument);
}

/**
 * Validate each file before concatenation so syntax errors retain their source positions.
 * Directives cannot survive concatenation; unresolved aliases are allowed until `toJS`.
 */
function parseSingleDocument(text: string, label: string): YAML.Document {
  const documents = YAML.parseAllDocuments(text, YAML_PARSE_OPTIONS);
  if (documents.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (documents.length > 1) {
    throw new Error(`${label} must be a single YAML document (found '---'/'...' document markers mid-file)`);
  }
  const document = documents[0];
  if (document.errors.length > 0) {
    throw new Error(`Failed to parse ${label}:\n${document.errors.map((error) => error.message).join("\n")}`);
  }
  const { yaml, tags } = document.directives;
  const hasCustomTags = Object.entries(tags).some(
    ([handle, prefix]) => handle !== "!!" || prefix !== "tag:yaml.org,2002:",
  );
  if (yaml.explicit || hasCustomTags) {
    throw new Error(`${label} uses %YAML/%TAG directives, which cannot be composed with sibling files — remove them`);
  }
  return document;
}

/** The string form of a YAML mapping key (scalar keys only), or `fallback` for anything else. */
export function pairKeyToString(key: unknown, fallback = ""): string {
  return YAML.isScalar(key) ? String(key.value) : fallback;
}

function rejectLabels(candidates: Iterable<string>, isViolation: (label: string) => boolean, description: string) {
  const violating = [...candidates].filter((label) => isViolation(label));
  if (violating.length > 0) {
    throw new Error(`${description}: ${violating.map((label) => `&${label}`).join(", ")}`);
  }
}

/**
 * Remove the BOM and document markers after single-document validation. Only column-0 markers
 * qualify; indented markers may be scalar content. Preserve line counts for error attribution.
 */
function stripDocumentMarkers(text: string): string {
  const lines = text.replace(/^\u{FEFF}/u, "").split("\n");

  const startIndex = lines.findIndex((line) => /^---(\s|$)/.test(line));
  if (startIndex !== -1) {
    // `--- {flow: doc}` carries document content on the marker line — keep everything after the marker.
    lines[startIndex] = lines[startIndex].slice("---".length).trimStart();
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\.\.\.(\s|$)/.test(lines[index])) {
      // A column-0 comment still terminates a preceding block scalar; a blank line would become
      // part of its value with keep chomping (`|+` / `>+`).
      lines[index] = `# ${lines[index]}`;
      break;
    }
  }

  return lines.join("\n");
}

function assertOnlyOwnedSections(document: YAML.Document, ownedSectionKeys: string[], fileLabel: string) {
  const sections = ownedSectionKeys.map((key) => `\`${key}:\``).join(" and/or ");
  if (!YAML.isMap(document.contents)) {
    throw new Error(`${fileLabel} must be a mapping with ${sections} section(s)`);
  }
  const keys = document.contents.items.map((pair) => pairKeyToString(pair.key, "<non-scalar key>"));
  const extraKeys = keys.filter((key) => !ownedSectionKeys.includes(key));
  if (extraKeys.length > 0) {
    throw new Error(`${fileLabel} may only contain ${sections} section(s), but also has: ${extraKeys.join(", ")}`);
  }
  if (keys.length === 0) {
    throw new Error(`${fileLabel} must contain ${sections} section(s)`);
  }
}

/** Every anchor name defined in `document`, in visit order (duplicates preserved). */
function collectAnchorNames(document: YAML.Document): string[] {
  const anchors: string[] = [];
  const collectAnchor = (_key: unknown, node: YAML.Scalar | YAML.YAMLMap | YAML.YAMLSeq) => {
    if (node.anchor) anchors.push(node.anchor);
  };
  YAML.visit(document, { Scalar: collectAnchor, Collection: collectAnchor });
  return anchors;
}

/**
 * Nested anchors bypass per-entry label collection and could shadow anchors from another file.
 */
function assertNoStrayAnchors(document: YAML.Document, labels: Set<string>, fileLabel: string) {
  const stray = new Set<string>();
  const seen = new Set<string>();
  for (const anchor of collectAnchorNames(document)) {
    if (!labels.has(anchor) || seen.has(anchor)) stray.add(anchor);
    seen.add(anchor);
  }
  if (stray.size > 0) {
    throw new Error(
      `anchor(s) in ${fileLabel} defined outside the labeled entries: ` +
        [...stray].map((anchor) => `&${anchor}`).join(", "),
    );
  }
}

function inspectMainDocument(mainDocument: YAML.Document): {
  anchors: Set<string>;
  aliases: Set<string>;
  presentKeys: Set<string>;
} {
  const anchors = new Set(collectAnchorNames(mainDocument));
  const aliases = new Set<string>();
  YAML.visit(mainDocument, {
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

type CombinedPart = { label: string; text: string };

function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") count++;
  }
  return count;
}

/** Map combined-text positions back to source files using the preserved per-file line counts. */
function describeCombinedParseError(error: YAML.YAMLError, parts: CombinedPart[], combinedText: string): string {
  const offset = Math.min(error.pos[0] ?? 0, Math.max(combinedText.length - 1, 0));
  const prefix = combinedText.slice(0, offset);
  const line = countNewlines(prefix) + 1;
  const column = offset - prefix.lastIndexOf("\n");
  let startLine = 1;
  for (const part of parts) {
    const lineCount = countNewlines(part.text); // every part ends with a newline
    if (line < startLine + lineCount || part === parts.at(-1)) {
      return `${error.message} (in ${part.label} at line ${line - startLine + 1}, column ${column})`;
    }
    startLine += lineCount;
  }
  return error.message;
}

/**
 * Validate section ownership and anchor references, then concatenate siblings before the main
 * config so YAML resolves cross-file aliases. Throws on invalid input.
 */
export function composeWithSiblings(mainText: string, siblings: { text: string; spec: SiblingSpec }[]): ComposeResult {
  const collected = siblings.map(({ text, spec }) => {
    const document = parseSingleDocument(text, spec.fileLabel);
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, spec.fileLabel);
    const labels = spec.collectLabels(document, spec.fileLabel);
    if (labels.size === 0) {
      throw new Error(`${spec.fileLabel} defines no labeled entries`);
    }
    assertNoStrayAnchors(document, labels, spec.fileLabel);
    return { spec, labels };
  });

  // Check syntax before references: malformed YAML can hide aliases and produce misleading label errors.
  const mainDocument = parseSingleDocument(mainText, "the main config");
  const { anchors: mainAnchors, aliases: mainAliases, presentKeys } = inspectMainDocument(mainDocument);

  for (const { spec } of siblings) {
    const ownedPresent = spec.ownedSectionKeys.filter((key) => presentKeys.has(key));
    if (ownedPresent.length > 0) {
      throw new Error(
        `the main config still has ${ownedPresent.map((key) => `\`${key}:\``).join(" / ")} section(s); ` +
          `move every value to ${spec.fileLabel} so the main config holds only the wiring`,
      );
    }
  }

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

  const fileLabels = siblings.map(({ spec }) => spec.fileLabel).join(" / ");
  rejectLabels(
    mainAliases,
    (alias) => !seenLabels.has(alias) && !mainAnchors.has(alias),
    `the main config references label(s) defined neither in it nor in ${fileLabels}`,
  );

  // Preserve original trailing whitespace, then terminate any block scalar with a column-0 comment
  // so blank lines at the start of the next file cannot extend its value. Keep the separator in its
  // preceding part so error attribution accounts for the extra line without shifting source lines.
  const parts: CombinedPart[] = [
    ...siblings.map(({ text, spec }) => ({ label: spec.fileLabel, text: stripDocumentMarkers(text) })),
    { label: "the main config", text: stripDocumentMarkers(mainText) },
  ].map(({ label, text }) => ({
    label,
    text: `${text.endsWith("\n") ? text : `${text}\n`}# End of config file\n`,
  }));
  const combinedText = parts.map(({ text }) => text).join("");
  // prettyErrors would decorate messages with positions in the concatenated text; positions are
  // re-derived per source file instead.
  const combinedDocument = YAML.parseDocument(combinedText, { ...YAML_PARSE_OPTIONS, prettyErrors: false });
  if (combinedDocument.errors.length > 0) {
    throw new Error(
      `Failed to parse the combined config:\n${combinedDocument.errors
        .map((error) => describeCombinedParseError(error, parts, combinedText))
        .join("\n")}`,
    );
  }

  return {
    document: combinedDocument.toJS(YAML_TO_JS_OPTIONS),
    labels: collected.map(({ labels }) => [...labels]),
  };
}

/** Detect aliases whose anchors are absent from the file; unreadable or non-single-document files return false. */
export function configDelegatesAnchors(configPath: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(configPath), "utf8");
  } catch {
    return false;
  }
  const documents = YAML.parseAllDocuments(text, YAML_PARSE_OPTIONS);
  if (documents.length !== 1) {
    return false;
  }
  const { anchors, aliases } = inspectMainDocument(documents[0]);
  return [...aliases].some((alias) => !anchors.has(alias));
}

/** Read the main config and each sibling, then compose them, exiting on any failure. */
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
