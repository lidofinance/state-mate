import fs from "node:fs";
import path from "node:path";

import * as YAML from "yaml";

import { printError, YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "./common";
import { logErrorAndExit } from "./logger";

// A contract/implementation address (20-byte) or a 32-byte hash (forward-compatibility). Shared by
// the value validation of delegated files (`.deployed`, the `.inputs` externals section): a strict
// check here catches typos / env-var names / REPLACEME that the schema's permissive EthereumString
// format (a trailing `.+` branch) would let through.
export const ADDRESS_OR_HASH_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

/**
 * Describes one kind of sibling "delegation" file (e.g. `.deployed`, `.inputs`). The generic engine
 * handles path resolution, document-marker stripping, the concat-then-parse composition, and the
 * cross-file invariants — including that the sibling holds only its owned sections and the main
 * config none of them; each spec supplies the bits that differ: the human and CLI labels, which
 * top-level sections it owns, and how to validate its own per-entry structure/values and collect its
 * `&label` anchors.
 */
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

/** True only when `filePath` exists and is a regular file (not a directory). */
function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolve an explicit `--option <path>`, throwing if it is missing or not a regular file. */
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

/**
 * Decide which sibling file to apply, or `null` for a standalone run. Sibling files are
 * EXPLICIT-ONLY: only the spec's `--<option> <path>` selects one, and a same-named file sitting next
 * to the main config is never picked up on its own — swapping a deployment's addresses or inputs
 * changes what is verified, so it must be a deliberate choice. Throws on a path that is missing or
 * not a file, including an empty one (an empty string from a hollow shell variable must not silently
 * degrade to a standalone run).
 */
export function resolveSiblingFilePath(spec: SiblingSpec, explicitArgument?: string): string | null {
  return explicitArgument === undefined ? null : resolveExplicitFilePath(spec.optionName, explicitArgument);
}

/**
 * Parse `text` as a single YAML document, with a file-targeted error if it is empty, multi-document,
 * uses `%YAML`/`%TAG` directives (they cannot survive concatenation into a combined stream), or has
 * syntax errors. (Note that an unresolved alias is NOT a parse error — the yaml library only
 * resolves aliases at `toJS` time — so the wiring-only main config parses cleanly on its own and any
 * error found here IS a genuine syntax error, positioned in the real file.)
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

/** Throw with `description` listing the labels (as `&name`) that satisfy `isViolation`, if any. */
function rejectLabels(candidates: Iterable<string>, isViolation: (label: string) => boolean, description: string) {
  const violating = [...candidates].filter((label) => isViolation(label));
  if (violating.length > 0) {
    throw new Error(`${description}: ${violating.map((label) => `&${label}`).join(", ")}`);
  }
}

/**
 * Prepare one file's text for concatenation into a single YAML stream: drop a UTF-8 BOM (legal at
 * the start of a file, content mid-stream), blank a leading `---` document-start marker and a
 * trailing `...` document-end marker. Only column-0 markers are document markers — an indented `...`
 * is scalar content and must survive — and `parseSingleDocument` has already guaranteed a single
 * document with no directives, so at most one of each marker can exist and any column-0 match IS
 * that marker. Marker lines are blanked in place (not removed) so every line of the original file
 * keeps its line number in the combined text — `describeCombinedParseError` relies on this.
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
      lines[index] = "";
      break;
    }
  }

  return lines.join("\n");
}

/** Reject a delegated document that is not a mapping of exactly the given owned sections. */
function assertOnlyOwnedSections(document: YAML.Document, ownedSectionKeys: string[], fileLabel: string) {
  const sections = ownedSectionKeys.map((key) => `\`${key}:\``).join(" and/or ");
  if (!YAML.isMap(document.contents)) {
    // eslint-disable-next-line unicorn/prefer-type-error -- user-facing config-validation error, not a programmer TypeError
    throw new Error(`${fileLabel} must be a mapping with ${sections} section(s)`);
  }
  const keys = document.contents.items.map((pair) => pairKeyToString(pair.key, "<non-scalar key>"));
  const extraKeys = keys.filter((key) => !ownedSectionKeys.includes(key));
  if (extraKeys.length > 0) {
    throw new Error(`${fileLabel} may only contain ${sections} section(s), but also has: ${extraKeys.join(", ")}`);
  }
  // A sibling is auto-loaded only when it exists, so a section-less one (e.g. an empty `{}` map) is a
  // mistake, not a no-op — reject it instead of silently contributing zero anchors.
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
 * Reject anchors a sibling file defines beyond its entry `&label`s. A nested anchor inside an entry's
 * collection value (e.g. `- &limits [3600, &lido 99]`) is invisible to the per-entry label collection,
 * so it would bypass the duplicate/collision invariants and silently shadow a same-named label from
 * another file once the texts are concatenated.
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

/** Collect the anchors a document defines, the aliases it references, and its top-level section keys. */
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

/**
 * Attribute a combined-parse error to the source file it came from: the marker-blanking in
 * `stripDocumentMarkers` preserves per-file line numbers, so a line of the combined text maps 1:1
 * onto a (file, line) pair. Without this the yaml library's positions would point into the
 * concatenated text — the wrong line of, usually, the wrong file.
 */
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
 * Compose a main config (wiring only) with one or more separate delegation files (the sole source of
 * their `&label` anchors) — the "full delegation" model. Pure; throws on any violation.
 *
 * The main config holds only the wiring — `*label` aliases — and none of the delegated sections.
 * Each sibling file holds only its own section(s), with one `&label` per delegated value. Because
 * YAML anchors can't be resolved across files, the texts are concatenated (sibling anchors first) and
 * parsed as a single document so every alias resolves natively. Before composing, the invariants are
 * enforced per sibling (only owned sections; every value labeled and valid; no anchors beyond the
 * entry labels; every label referenced by the main config; no duplicate label) and across files (the
 * main config has none of the delegated sections; no label collides with a main anchor or with
 * another sibling's label; every main alias resolves).
 */
export function composeWithSiblings(mainText: string, siblings: { text: string; spec: SiblingSpec }[]): ComposeResult {
  const collected = siblings.map(({ text, spec }) => {
    const document = parseSingleDocument(text, spec.fileLabel);
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, spec.fileLabel);
    const labels = spec.collectLabels(document, spec.fileLabel);
    // The owned sections exist (checked above), so zero labels means they are all empty — a
    // mistake, not a no-op, same as a section-less file.
    if (labels.size === 0) {
      throw new Error(`${spec.fileLabel} defines no labeled entries`);
    }
    assertNoStrayAnchors(document, labels, spec.fileLabel);
    return { spec, labels };
  });

  // Unresolved aliases are not parse errors (they only surface at `toJS`), so the wiring-only main
  // config can — and must — be syntax-checked standalone: here the error positions refer to the real
  // file, and a syntax error that swallows the aliases cannot masquerade as a bogus invariant
  // violation.
  const mainDocument = parseSingleDocument(mainText, "the main config");
  const { anchors: mainAnchors, aliases: mainAliases, presentKeys } = inspectMainDocument(mainDocument);

  // Full delegation: the main config must hold none of the delegated sections.
  for (const { spec } of siblings) {
    const ownedPresent = spec.ownedSectionKeys.filter((key) => presentKeys.has(key));
    if (ownedPresent.length > 0) {
      throw new Error(
        `the main config still has ${ownedPresent.map((key) => `\`${key}:\``).join(" / ")} section(s); ` +
          `move every value to ${spec.fileLabel} so the main config holds only the wiring`,
      );
    }
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

  // No trimming beyond a guaranteed line break between files: stripping trailing whitespace would
  // corrupt a keep-chomped block scalar (`|+`) whose trailing newlines are significant.
  const parts: CombinedPart[] = [
    ...siblings.map(({ text, spec }) => ({ label: spec.fileLabel, text: stripDocumentMarkers(text) })),
    { label: "the main config", text: stripDocumentMarkers(mainText) },
  ].map(({ label, text }) => ({ label, text: text.endsWith("\n") ? text : `${text}\n` }));
  const combinedText = parts.map(({ text }) => text).join("");
  // prettyErrors would decorate messages with positions in the concatenated text; positions are
  // re-derived per source file instead. (Parsing semantics still come from YAML_PARSE_OPTIONS.)
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

/**
 * True when the file references aliases whose anchors it does not define itself — i.e. a wiring-only
 * main config that delegates to sibling file(s) and cannot be parsed standalone. Read/parse failures
 * yield `false`: the regular loading path reports those properly.
 */
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
