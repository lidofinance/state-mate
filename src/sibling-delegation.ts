import fs from "node:fs";
import path from "node:path";

import * as YAML from "yaml";

import { printError, YAML_PARSE_OPTIONS, YAML_TO_JS_OPTIONS } from "./common";
import { logErrorAndExit } from "./logger";

// Enforce 20-byte addresses or 32-byte hashes; the schema also accepts placeholders such as REPLACEME.
export const ADDRESS_OR_HASH_RE = /^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/;

/** Explain YAML's numeric interpretation without losing the original hex spelling. */
export function invalidAddressMessage(scalar: YAML.Scalar): string {
  if (typeof scalar.value === "bigint" && scalar.format === "HEX") {
    return (
      `label &${scalar.anchor} is not a valid address: unquoted hex literal ${scalar.source}. ` +
      `Quote the value to preserve it as an address or hash.`
    );
  }
  return `label &${scalar.anchor} is not a valid address: ${String(scalar.value)}`;
}

/** Validation rules and section ownership for a sibling file such as `.deployed` or `.inputs`. */
export type SiblingSpec = {
  /** The CLI option that selects the file, e.g. `--deployed` (used in resolution errors). */
  optionName: string;
  /** Human-facing label for this kind of file, e.g. `the .deployed file` (used in error messages). */
  fileLabel: string;
  /** What this kind of file's labeled entries are, e.g. `deployed address(es)` (used in the load log). */
  entryNoun: string;
  /**
   * Top-level section keys this sibling owns, in the order the composed document lists them: a
   * section whose entries may alias another section's entries comes after it. The sibling holds
   * only these sections, the main config none of them, and no two kinds own one key.
   */
  ownedSectionKeys: string[];
  /**
   * Validate the sibling's sections/values and return its entry `&label` anchors. Throws on any
   * violation; the engine names the file in the error, so messages need not.
   */
  collectLabels: (document: YAML.Document) => Set<string>;
};

/** One sibling file's text under its spec; `label` names this file in diagnostics (defaults to the kind's label). */
export type SiblingSource = { text: string; spec: SiblingSpec; label?: string };

/** One selected sibling file on disk under its spec. */
export type SelectedSibling = { path: string; spec: SiblingSpec };

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

/**
 * Resolve every explicitly supplied path in argument order; an empty argument must fail rather
 * than select a standalone run. A file is identified by what it resolves to on disk, so one file
 * under two spellings (or through a symlink) is the same file, and selecting it twice is rejected
 * before its anchors could clash with themselves.
 */
export function resolveSiblingFilePaths(spec: SiblingSpec, explicitArguments: string[]): string[] {
  const firstSpelling = new Map<string, string>();
  return explicitArguments.map((argument) => {
    const resolved = resolveExplicitFilePath(spec.optionName, argument);
    const identity = fs.realpathSync(resolved);
    const earlier = firstSpelling.get(identity);
    if (earlier !== undefined) {
      const alias = earlier === argument ? "" : ` (the same file as ${earlier})`;
      throw new Error(`The ${spec.optionName} file is selected more than once: ${argument}${alias}`);
    }
    firstSpelling.set(identity, argument);
    return resolved;
  });
}

/** Discover only same-stem siblings in the main config's directory; never choose between alternatives. */
export function discoverSiblingPaths(configPath: string): { deployed: string[]; inputs: string[] } {
  const stem = path.resolve(configPath).replace(/\.ya?ml$/, "");
  const selected = { deployed: [] as string[], inputs: [] as string[] };
  for (const kind of ["deployed", "inputs"] as const) {
    const candidates = ["yaml", "yml"].map((extension) => `${stem}.${kind}.${extension}`);
    const existing = candidates.filter((candidate) => fs.existsSync(candidate));
    if (existing.length > 1) {
      throw new Error(`Ambiguous ${kind} siblings for ${configPath}: ${existing.join(", ")}`);
    }
    selected[kind] = existing.map((candidate) =>
      resolveExplicitFilePath(`--auto-load-deployed-and-inputs (${kind})`, candidate),
    );
  }
  return selected;
}

type ParsedSource = { document: YAML.Document; label: string; lineCounter: YAML.LineCounter };

/**
 * The construction rule for one owned section split across several files of a kind: mappings
 * unite by key (recursing where both hold the key), lists concatenate, and the earlier file's
 * entries come first. Each spec's validator has already fixed the shape of every section it owns,
 * so two files of one kind cannot disagree on it; the throws cover a spec that admits several.
 */
function uniteSections(target: unknown, incoming: unknown, sectionPath: string, fileLabel: string) {
  const cannotUnite = (reason: string) =>
    new Error(`Cannot unite \`${sectionPath}\` from ${fileLabel} with an earlier file: ${reason}`);
  if (YAML.isMap(target) && YAML.isMap(incoming)) {
    const keyOf = (pair: YAML.Pair) => {
      if (!YAML.isScalar(pair.key)) throw cannotUnite("mapping keys must be scalars");
      return String(pair.key.value);
    };
    for (const pair of incoming.items) {
      const key = keyOf(pair);
      const existing = target.items.find((candidate) => keyOf(candidate) === key);
      if (existing) {
        uniteSections(existing.value, pair.value, `${sectionPath}.${key}`, fileLabel);
      } else {
        target.items.push(pair);
      }
    }
  } else if (YAML.isSeq(target) && YAML.isSeq(incoming)) {
    target.items.push(...incoming.items);
  } else {
    throw cannotUnite("the sections differ in shape");
  }
}

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

function rejectLabels(
  candidates: Iterable<string>,
  isViolation: (label: string) => boolean,
  description: string,
  annotate: (label: string) => string = () => "",
) {
  const violating = [...candidates].filter((label) => isViolation(label));
  if (violating.length > 0) {
    throw new Error(`${description}: ${violating.map((label) => `&${label}${annotate(label)}`).join(", ")}`);
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
 * Validate section ownership and anchor references, then assemble one document. Its layout is
 * fixed by the kinds, not by the files: the sections of each kind in the order the kinds were
 * selected, each kind's sections in its spec's order, and main's entries last. Selection order
 * decides only where a file's entries fall inside a section: several siblings of one kind each
 * hold a part of the sections that kind owns, and the parts unite earlier file first (see
 * `uniteSections`), so the composed document carries one section per key. An alias resolves only
 * to an anchor laid out before it. Parsed nodes are consumed locally; YAML expands aliases in the
 * assembled document.
 */
export function composeWithSiblings(mainText: string, siblings: SiblingSource[]): ComposeResult {
  const collected = siblings.map(({ text, spec, label = spec.fileLabel }) => {
    const source = parseSingleDocument(text, label);
    const { document } = source;
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, label);
    requireMappingRoot(source);
    let labels: Set<string>;
    try {
      labels = spec.collectLabels(document);
    } catch (error) {
      throw new Error(`${printError(error)} (in ${label})`);
    }
    if (labels.size === 0) {
      throw new Error(`${label} defines no labeled entries`);
    }
    assertNoStrayAnchors(document, labels, label);
    return { spec, labels, source };
  });

  // The files of one kind, in selection order. A kind's sections are its spec's alone: two kinds
  // owning one key would leave a repeated key at assembly with no rule to unite it by.
  const kinds = new Map<SiblingSpec, string[]>();
  for (const { spec, source } of collected) kinds.set(spec, [...(kinds.get(spec) ?? []), source.label]);
  const owners = new Map<string, SiblingSpec>();
  for (const spec of kinds.keys()) {
    for (const key of spec.ownedSectionKeys) {
      const other = owners.get(key);
      if (other && other !== spec) {
        throw new Error(
          `\`${key}:\` is owned by both ${other.fileLabel} and ${spec.fileLabel}; sibling kinds must own distinct sections`,
        );
      }
      owners.set(key, spec);
    }
  }

  // Check syntax before references: malformed YAML can hide aliases and produce misleading label errors.
  const mainSource = parseSingleDocument(mainText, "the main config");
  const mainDocument = mainSource.document;
  requireMappingRoot(mainSource);
  const { anchors: mainAnchors, aliases: mainAliases, presentKeys } = inspectMainDocument(mainDocument);

  for (const [spec, fileLabels] of kinds) {
    const ownedPresent = spec.ownedSectionKeys.filter((key) => presentKeys.has(key));
    if (ownedPresent.length > 0) {
      throw new Error(
        `the main config still has ${ownedPresent.map((key) => `\`${key}:\``).join(" / ")} section(s); ` +
          `move every value to ${fileLabels.join(" or ")} so the main config holds only the wiring`,
      );
    }
  }

  const definedIn = new Map<string, string>();
  for (const { source, labels } of collected) {
    rejectLabels(
      labels,
      (label) => mainAnchors.has(label),
      `label(s) defined in both the main config and ${source.label}`,
    );
    rejectLabels(
      labels,
      (label) => definedIn.has(label),
      `label(s) defined in more than one delegated file`,
      (label) => ` (in ${definedIn.get(label)} and ${source.label})`,
    );
    for (const label of labels) definedIn.set(label, source.label);
    rejectLabels(
      labels,
      (label) => !mainAliases.has(label),
      `label(s) in ${source.label} are never referenced in the main config`,
    );
  }

  const combinedDocument = new YAML.Document(undefined, YAML_PARSE_OPTIONS);
  const root = new YAML.YAMLMap(combinedDocument.schema);
  const nodeSources = new WeakMap<YAML.Node, ParsedSource>();
  const rootPairs = (source: ParsedSource): [string, YAML.Pair][] => {
    YAML.visit(source.document, {
      Node: (_key, node) => {
        nodeSources.set(node, source);
      },
    });
    return requireMappingRoot(source).items.map((pair) => {
      if (!YAML.isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error(`Top-level keys must be strings (${sourcePosition(source, pair.key)})`);
      }
      return [pair.key.value, pair];
    });
  };
  // Siblings first, then main. Every sibling holds only sections its kind owns and kinds own
  // distinct keys (both checked above), so a key seen twice is one owned section split across
  // files of a kind, and the parts unite. The layout documented above puts every section of a
  // kind before the next kind's and orders a kind's sections as its spec lists them, so neither
  // argument order nor a file's own section order decides whether an alias finds its anchor.
  // Main holds none of the owned sections and so cannot collide.
  const sections = new Map<string, YAML.Pair>();
  for (const { source } of collected) {
    for (const [key, pair] of rootPairs(source)) {
      const earlier = sections.get(key);
      if (earlier) {
        uniteSections(earlier.value, pair.value, key, source.label);
      } else {
        sections.set(key, pair);
      }
    }
  }
  for (const key of new Set([...kinds.keys()].flatMap((spec) => spec.ownedSectionKeys))) {
    const pair = sections.get(key);
    if (pair) root.add(pair);
  }
  for (const [, pair] of rootPairs(mainSource)) root.add(pair);
  combinedDocument.contents = root;

  // Match YAML's nearest-preceding-anchor rule by node identity: an alias without a preceding
  // anchor either has one later in the composed document or none at all. An ancestor target
  // forms a cycle that our bigint reviver cannot convert. Collect diagnostics before conversion.
  const anchorNodes = new Map<string, YAML.Node>();
  YAML.visit(combinedDocument, {
    Node: (_key, node) => {
      if (node.anchor) anchorNodes.set(node.anchor, node);
    },
  });
  const precedingAnchors = new Map<string, YAML.Node>();
  const aliasErrors: string[] = [];
  const fileLabels = collected.map(({ source }) => source.label).join(" / ");
  YAML.visit(combinedDocument, {
    Node: (_key, node, ancestors) => {
      if (YAML.isAlias(node)) {
        const target = precedingAnchors.get(node.source);
        const position = sourcePosition(nodeSources.get(node)!, node);
        const later = anchorNodes.get(node.source);
        if (target) {
          if (ancestors.includes(target)) {
            aliasErrors.push(`Cyclic alias *${node.source}: references an ancestor collection (${position})`);
          }
        } else if (later) {
          aliasErrors.push(
            `Unresolved alias *${node.source}: the anchor must be set before the alias (${position}), ` +
              `but &${node.source} is only set later (${sourcePosition(nodeSources.get(later)!, later)})`,
          );
        } else {
          const description =
            nodeSources.get(node) === mainSource
              ? `the main config references label(s) ${fileLabels ? `defined neither in it nor in ${fileLabels}` : "not defined in it"}: &${node.source}`
              : `Unresolved alias *${node.source}: anchor is not defined in any composed source`;
          aliasErrors.push(`${description} (${position})`);
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

/**
 * Read the main config and each sibling, then compose them, exiting on any failure. Diagnostics
 * name every sibling by its kind and its path relative to the working directory.
 */
export function loadStateWithSiblings(configPath: string, siblings: SelectedSibling[]): ComposeResult {
  let mainText: string;
  let siblingTexts: SiblingSource[];
  try {
    mainText = fs.readFileSync(path.resolve(configPath), "utf8");
    siblingTexts = siblings.map(({ path: siblingPath, spec }) => ({
      text: fs.readFileSync(path.resolve(siblingPath), "utf8"),
      spec,
      label: `${spec.fileLabel} ${path.relative(process.cwd(), siblingPath)}`,
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
