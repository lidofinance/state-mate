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
 * cross-file invariants — including that the sibling holds only its owned sections and the main
 * config none of them; each spec supplies the bits that differ: the filename infix, the human and
 * CLI labels, which top-level sections it owns, and how to validate its own per-entry structure/
 * values and collect its `&label` anchors.
 */
export type SiblingSpec = {
  /** Filename infix inserted before the extension, e.g. `.deployed` -> `lido.deployed.yaml`. */
  infix: string;
  /** The CLI option that selects an explicit path, e.g. `--deployed` (used in resolution errors). */
  optionName: string;
  /** Human-facing label for this file, e.g. `the .deployed file` (used in error messages). */
  fileLabel: string;
  /** Top-level section keys this sibling owns; it holds only these, the main config none of them. */
  ownedSectionKeys: string[];
  /** Validate the sibling's sections/values and return its entry `&label` anchors. Throws on any violation. */
  collectLabels: (document: YAML.Document) => Set<string>;
};

/**
 * Describes an "overlay" file that REDEFINES values already defined by a base sibling (e.g. an
 * `--overrides` file over the `.inputs` file) rather than defining new ones. It shares the base's
 * method — the same sections, one `&label` per entry, the same per-entry validation — but plays a
 * different role: it deliberately reuses the base's anchors (so it is exempt from the no-duplicate
 * invariant), and must instead satisfy rules of its own — every label already exists in the base (it
 * may not introduce one), every label keeps the section the base used, and every value differs from
 * the base (a no-op restatement is a mistake).
 */
export type OverlaySpec = {
  /** The CLI option that selects this file, e.g. `--overrides` (used in messages). */
  optionName: string;
  /** Human-facing label for this file, e.g. `the overrides file` (used in error messages). */
  fileLabel: string;
  /** Top-level section keys this file owns; same as its base (the main config holds none of them). */
  ownedSectionKeys: string[];
  /** The base sibling whose labels this file may redefine; located among the siblings by identity. */
  baseSpec: SiblingSpec;
  /**
   * Validate the file's sections/values (exactly as the base does) and return, per `&label`: the
   * label set, the (reviver-normalized) value, and the owning section. The same collector runs
   * against both the overlay and its base, so `fileLabel` targets any error at the right file.
   */
  collect: (
    document: YAML.Document,
    fileLabel: string,
  ) => { labels: Set<string>; values: Map<string, unknown>; sections: Map<string, string> };
};

export type ComposeResult = {
  document: unknown;
  /** Labels collected from each sibling, parallel to the input `siblings` array. */
  labels: string[][];
  /** Labels applied by each overlay (e.g. an overrides file), parallel to the input `overlays` array. */
  overlayLabels: string[][];
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

/** Resolve an explicit `--option <path>`, throwing if it is missing or not a regular file. */
export function resolveExplicitFilePath(optionName: string, argument: string): string {
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
    return resolveExplicitFilePath(spec.optionName, explicitArgument);
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
 * Does NOT assert the absence of parse errors itself; callers do. (Note that an unresolved alias is
 * NOT a parse error — the yaml library only resolves aliases at `toJS` time — so the wiring-only main
 * config parses cleanly on its own and any error found IS a genuine syntax error.)
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
  if (firstSignificant !== -1) {
    const trimmed = lines[firstSignificant].trim();
    if (/^---(\s|$)/.test(trimmed)) {
      // `--- {flow: doc}` carries document content on the marker line — keep it; drop marker-only
      // (or marker-plus-comment) lines entirely.
      const rest = trimmed.slice("---".length).trim();
      if (rest === "" || rest.startsWith("#")) {
        lines.splice(firstSignificant, 1);
      } else {
        lines[firstSignificant] = rest;
      }
    }
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

/** Reject a delegated/overlay document that is not a mapping of exactly the given owned sections. */
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

/**
 * A wrapper key — not a real config section — under which an overlay's redefined anchors are emitted
 * into the combined text, so they sit after their base's anchors (and win by most-recent-preceding
 * resolution) without colliding with the base's top-level section keys (a duplicate top-level key is
 * a hard parse error). Stripped from the composed result so the document equals a sibling-only one.
 */
const SYNTHETIC_OVERLAY_KEY = "__state_mate_overrides__";

/**
 * Re-emit one or more overlays' labeled entries as ONE synthetic-key block, reusing the parsed nodes
 * so every `&label` and its exact value representation survive serialization. The original section
 * keys are dropped (a label's section is validated separately); only the anchor bindings drive
 * resolution. A single shared block is used for all overlays so they never collide on a duplicate
 * top-level key — cross-overlay label clashes are rejected before this point.
 */
function buildOverlaySyntheticText(documents: YAML.Document[]): string {
  const seq = new YAML.YAMLSeq();
  for (const document of documents) {
    if (YAML.isMap(document.contents)) {
      for (const pair of document.contents.items) {
        if (YAML.isSeq(pair.value)) {
          for (const item of pair.value.items) seq.items.push(item);
        }
      }
    }
  }
  const synthetic = new YAML.Document();
  const map = new YAML.YAMLMap();
  map.set(SYNTHETIC_OVERLAY_KEY, seq);
  synthetic.contents = map;
  return String(synthetic);
}

/**
 * Reject anchors a sibling file defines beyond its entry `&label`s. A nested anchor inside an entry's
 * collection value (e.g. `- &limits [3600, &lido 99]`) is invisible to the per-entry label collection,
 * so it would bypass the duplicate/collision invariants and silently shadow a same-named label from
 * another file once the texts are concatenated.
 */
function assertNoStrayAnchors(document: YAML.Document, labels: Set<string>, fileLabel: string) {
  const anchors: string[] = [];
  const collectAnchor = (_key: unknown, node: YAML.Scalar | YAML.YAMLMap | YAML.YAMLSeq) => {
    if (node.anchor) anchors.push(node.anchor);
  };
  YAML.visit(document, { Scalar: collectAnchor, Collection: collectAnchor });
  const stray = anchors.filter((anchor, index) => !labels.has(anchor) || anchors.indexOf(anchor) !== index);
  if (stray.length > 0) {
    throw new Error(
      `anchor(s) in ${fileLabel} defined outside the labeled entries: ` +
        `${[...new Set(stray)].map((anchor) => `&${anchor}`).join(", ")}`,
    );
  }
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
 * enforced per sibling (only owned sections; every value labeled and valid; no anchors beyond the
 * entry labels; every label referenced by the main config; no duplicate label) and across files (the
 * main config has none of the delegated sections; no label collides with a main anchor or with
 * another sibling's label; every main alias resolves).
 *
 * Optional `overlays` REDEFINE existing sibling values rather than defining new ones (e.g. an
 * `--overrides` file over `.inputs`): each is validated like its base, must only redefine existing
 * base labels (keeping their sections) with changed values, and is emitted after its base so the main
 * aliases resolve to the override.
 */
export function composeWithSiblings(
  mainText: string,
  siblings: { text: string; spec: SiblingSpec }[],
  overlays: { text: string; spec: OverlaySpec }[] = [],
): ComposeResult {
  const collected = siblings.map(({ text, spec }) => {
    const document = parseSingleDocument(text, spec.fileLabel);
    assertNoParseErrors(document, spec.fileLabel);
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, spec.fileLabel);
    const labels = spec.collectLabels(document);
    assertNoStrayAnchors(document, labels, spec.fileLabel);
    return { spec, labels, document };
  });

  // Unresolved aliases are not parse errors (they only surface at `toJS`), so the wiring-only main
  // config can — and must — be syntax-checked standalone: here the error positions refer to the real
  // file, while the combined parse below would offset them by the prepended sibling text and, worse,
  // a syntax error that swallows the aliases would masquerade as a bogus invariant violation.
  const mainDocument = parseSingleDocument(mainText, "the main config");
  assertNoParseErrors(mainDocument, "the main config");
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

  // Overlays REDEFINE existing sibling values (e.g. an `--overrides` file over `.inputs`). An overlay
  // deliberately reuses its base's `&label` anchors — so it is exempt from the no-duplicate /
  // referenced-in-main invariants above — but must instead only redefine labels the base defines,
  // keep each label's section, and change every value. Their anchors are emitted (in one synthetic
  // block) after every sibling, so the main aliases resolve to the override by most-recent-preceding.
  const overlayDocuments: YAML.Document[] = [];
  const overlayLabels: string[][] = [];
  const overlaySeen = new Set<string>();
  for (const { text, spec } of overlays) {
    const document = parseSingleDocument(text, spec.fileLabel);
    assertNoParseErrors(document, spec.fileLabel);
    assertOnlyOwnedSections(document, spec.ownedSectionKeys, spec.fileLabel);
    const { labels, values, sections } = spec.collect(document, spec.fileLabel);
    assertNoStrayAnchors(document, labels, spec.fileLabel);
    const overlayLabelList = [...labels];

    const base = collected.find(({ spec: siblingSpec }) => siblingSpec === spec.baseSpec);
    if (!base) {
      throw new Error(`${spec.fileLabel} needs ${spec.baseSpec.fileLabel} to override, but it is not present`);
    }
    const baseEntries = spec.collect(base.document, spec.baseSpec.fileLabel);

    // An override may neither introduce a new label nor redefine one already taken by another overlay.
    rejectLabels(
      labels,
      (label) => !base.labels.has(label),
      `label(s) in ${spec.fileLabel} are not defined in ${spec.baseSpec.fileLabel} (overrides cannot introduce new labels)`,
    );
    rejectLabels(labels, (label) => overlaySeen.has(label), `label(s) overridden by more than one overrides file`);
    for (const label of labels) overlaySeen.add(label);

    // A label must keep the section its base used: a move would change its kind and (for an
    // `externals` address moved to `config`) silently drop the address check.
    const moved = overlayLabelList.filter((label) => sections.get(label) !== baseEntries.sections.get(label));
    if (moved.length > 0) {
      throw new Error(
        `override(s) in ${spec.fileLabel} placed under a different section than ${spec.baseSpec.fileLabel}: ` +
          moved
            .map((label) => `&${label} (\`${sections.get(label)}:\` vs \`${baseEntries.sections.get(label)}:\`)`)
            .join(", "),
      );
    }

    // An override must CHANGE the value (a no-op is a mistake). Compare the reviver-normalized value
    // so a format-only change (`560048` vs `"560048"`) and a same-order array are caught, while a
    // genuine reorder (`[1,2]` -> `[2,1]`) is allowed.
    const canonical = (value: unknown) => JSON.stringify(value ?? null);
    const noop = overlayLabelList.filter(
      (label) => canonical(values.get(label)) === canonical(baseEntries.values.get(label)),
    );
    if (noop.length > 0) {
      throw new Error(
        `no-op override(s) in ${spec.fileLabel} — value unchanged from ${spec.baseSpec.fileLabel}: ` +
          noop.map((label) => `&${label}`).join(", "),
      );
    }

    overlayDocuments.push(document);
    overlayLabels.push(overlayLabelList);
  }

  // The synthetic overlay key is reserved; a main config that uses it as a real top-level key would
  // collide with the block below and be silently dropped by the strip at the end. Fail clearly.
  if (overlayDocuments.length > 0 && presentKeys.has(SYNTHETIC_OVERLAY_KEY)) {
    throw new Error(`the main config uses the reserved top-level key \`${SYNTHETIC_OVERLAY_KEY}:\``);
  }

  // No trimming beyond a guaranteed line break between files: stripping trailing whitespace would
  // corrupt a keep-chomped block scalar (`|+`) whose trailing newlines are significant. All overlay
  // anchors go in one block after every sibling (hence after their base) and before the main aliases.
  const overlayText = overlayDocuments.length > 0 ? buildOverlaySyntheticText(overlayDocuments) : null;
  const combinedText = [
    ...siblings.map(({ text }) => stripDocumentMarkers(text)),
    ...(overlayText === null ? [] : [stripDocumentMarkers(overlayText)]),
    stripDocumentMarkers(mainText),
  ]
    .map((text) => (text.endsWith("\n") ? text : `${text}\n`))
    .join("");
  const combinedDocument = YAML.parseDocument(combinedText, YAML_PARSE_OPTIONS);
  assertNoParseErrors(combinedDocument, "the combined config");

  // Drop the synthetic overlay wrapper so the composed document is identical to a sibling-only one.
  const document = combinedDocument.toJS({ reviver: yamlBigintReviver });
  if (document && typeof document === "object") {
    delete (document as Record<string, unknown>)[SYNTHETIC_OVERLAY_KEY];
  }

  return {
    document,
    labels: collected.map(({ labels }) => [...labels]),
    overlayLabels,
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

/** Read the main config, each sibling, and each overlay, then compose them, exiting on any failure. */
export function loadStateWithSiblings(
  configPath: string,
  siblings: { path: string; spec: SiblingSpec }[],
  overlays: { path: string; spec: OverlaySpec }[] = [],
): ComposeResult {
  let mainText: string;
  let siblingTexts: { text: string; spec: SiblingSpec }[];
  let overlayTexts: { text: string; spec: OverlaySpec }[];
  try {
    mainText = fs.readFileSync(path.resolve(configPath), "utf8");
    siblingTexts = siblings.map(({ path: siblingPath, spec }) => ({
      text: fs.readFileSync(path.resolve(siblingPath), "utf8"),
      spec,
    }));
    overlayTexts = overlays.map(({ path: overlayPath, spec }) => ({
      text: fs.readFileSync(path.resolve(overlayPath), "utf8"),
      spec,
    }));
  } catch (error) {
    return logErrorAndExit(`Failed to read config files:\n${printError(error)}`);
  }
  try {
    return composeWithSiblings(mainText, siblingTexts, overlayTexts);
  } catch (error) {
    return logErrorAndExit(printError(error));
  }
}
