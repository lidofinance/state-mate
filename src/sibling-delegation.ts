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

type ParsedSource = { document: YAML.Document; label: string; lineCounter: YAML.LineCounter };

/** Parse each source once with shared semantics; unresolved aliases are allowed until assembly. */
function parseSingleDocument(text: string, label: string): ParsedSource {
  const lineCounter = new YAML.LineCounter();
  const documents = YAML.parseAllDocuments(text, { ...YAML_PARSE_OPTIONS, lineCounter });
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
  return { document, label, lineCounter };
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

function sourcePosition(source: ParsedSource, node: unknown): string {
  const offset = YAML.isNode(node) ? node.range?.[0] : undefined;
  const { line, col } = source.lineCounter.linePos(offset ?? 0);
  return `in ${source.label} at line ${line}, column ${col}`;
}

function requireMappingRoot(source: ParsedSource): YAML.YAMLMap {
  const root = source.document.contents;
  if (!YAML.isMap(root)) {
    throw new Error(`${source.label} must contain a mapping (${sourcePosition(source, root)})`);
  }
  // The root container is replaced during assembly; its anchor/tag cannot be transferred to
  // the combined root without changing what it describes.
  if (root.anchor || root.tag) {
    throw new Error(`Root anchors and tags are unsupported in composed files (${sourcePosition(source, root)})`);
  }
  return root;
}

/**
 * Validate section ownership and anchor references, then assemble sibling mapping entries before
 * main's entries. Parsed nodes are consumed locally; YAML expands aliases in the assembled document.
 */
export function composeWithSiblings(mainText: string, siblings: { text: string; spec: SiblingSpec }[]): ComposeResult {
  const collected = siblings.map(({ text, spec }) => {
    const source = parseSingleDocument(text, spec.fileLabel);
    const { document } = source;
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, spec.fileLabel);
    requireMappingRoot(source);
    const labels = spec.collectLabels(document, spec.fileLabel);
    if (labels.size === 0) {
      throw new Error(`${spec.fileLabel} defines no labeled entries`);
    }
    assertNoStrayAnchors(document, labels, spec.fileLabel);
    return { spec, labels, source };
  });

  // Check syntax before references: malformed YAML can hide aliases and produce misleading label errors.
  const mainSource = parseSingleDocument(mainText, "the main config");
  const mainDocument = mainSource.document;
  requireMappingRoot(mainSource);
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

  const combinedDocument = new YAML.Document(undefined, YAML_PARSE_OPTIONS);
  const root = new YAML.YAMLMap(combinedDocument.schema);
  const sources = [...collected.map(({ source }) => source), mainSource];
  const nodeSources = new WeakMap<YAML.Node, ParsedSource>();
  const definitions = new Map<string, string>();
  for (const source of sources) {
    YAML.visit(source.document, {
      Node: (_key, node) => {
        nodeSources.set(node, source);
      },
    });
    for (const pair of requireMappingRoot(source).items) {
      const position = sourcePosition(source, pair.key);
      if (!YAML.isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error(`Top-level keys must be strings (${position})`);
      }
      const firstPosition = definitions.get(pair.key.value);
      if (firstPosition) {
        throw new Error(`Duplicate top-level key '${pair.key.value}' (${position}; first defined ${firstPosition})`);
      }
      definitions.set(pair.key.value, position);
      root.add(pair);
    }
  }
  combinedDocument.contents = root;

  // Match YAML's nearest-preceding-anchor rule by node identity. An ancestor target forms
  // a cycle that our bigint reviver cannot convert. Collect diagnostics before conversion.
  const precedingAnchors = new Map<string, YAML.Node>();
  const aliasErrors: string[] = [];
  const fileLabels = siblings.map(({ spec }) => spec.fileLabel).join(" / ");
  YAML.visit(combinedDocument, {
    Node: (_key, node, ancestors) => {
      if (YAML.isAlias(node)) {
        const target = precedingAnchors.get(node.source);
        const position = sourcePosition(nodeSources.get(node)!, node);
        if (!target) {
          if (!seenLabels.has(node.source) && !mainAnchors.has(node.source)) {
            const description =
              nodeSources.get(node) === mainSource
                ? `the main config references label(s) ${fileLabels ? `defined neither in it nor in ${fileLabels}` : "not defined in it"}: &${node.source}`
                : `Unresolved alias *${node.source}: anchor is not defined in any composed source`;
            aliasErrors.push(`${description} (${position})`);
          } else {
            aliasErrors.push(`Unresolved alias *${node.source}: the anchor must be set before the alias (${position})`);
          }
        } else if (ancestors.includes(target)) {
          aliasErrors.push(`Cyclic alias *${node.source}: references an ancestor collection (${position})`);
        }
      } else if (node.anchor) {
        precedingAnchors.set(node.anchor, node);
      }
    },
  });
  if (aliasErrors.length > 0) {
    throw new Error(aliasErrors.join("\n"));
  }

  let document: unknown;
  try {
    document = combinedDocument.toJS(YAML_TO_JS_OPTIONS);
  } catch (error) {
    throw new Error(`Failed to convert the composed config: ${printError(error)}`);
  }

  return {
    document,
    labels: collected.map(({ labels }) => [...labels]),
  };
}

/** List aliases with absent anchors; leave unreadable, malformed, and multi-document files to the parser. */
export function getMissingConfigAliases(configPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(configPath), "utf8");
  } catch {
    return [];
  }
  const documents = YAML.parseAllDocuments(text, YAML_PARSE_OPTIONS);
  if (documents.length !== 1 || documents[0].errors.length > 0) {
    return [];
  }
  const { anchors, aliases } = inspectMainDocument(documents[0]);
  return [...aliases].filter((alias) => !anchors.has(alias));
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
