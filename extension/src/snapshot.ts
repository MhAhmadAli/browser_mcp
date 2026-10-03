import type { Cdp } from "./cdp";

type AXValue = { type: string; value?: unknown };

type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
};

/** A snapshot entry: plain text, or an element the model can target by ref. */
type Item = string | SnapshotElement;

type SnapshotElement = {
  role: string;
  name: string;
  attributes: string[];
  ref?: string;
  /** Current value of a form field. */
  value?: string;
  /** Destination of a link. */
  url?: string;
  children: Item[];
};

const skippedRoles = new Set(["InlineTextBox", "ListMarker"]);

/** Roles that add nothing to a snapshot unless they have a name or can take focus. */
const wrapperRoles = new Set(["generic", "none", "presentation", "MenuListPopup"]);

const fieldRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

/** Tables used only for layout, whose names just repeat their content. */
const layoutRoles = new Set(["LayoutTable", "LayoutTableRow", "LayoutTableCell"]);

/** Chrome-internal role names mapped to their ARIA equivalents. */
const roleNames: Record<string, string> = {
  image: "img",
  Iframe: "iframe",
  LabelText: "label",
  LayoutTable: "generic",
  LayoutTableRow: "generic",
  LayoutTableCell: "generic",
  MenuListOption: "option",
};

/**
 * Captures the page's accessibility tree as YAML-like text. Each element gets a
 * ref (`d<document>e<backend DOM node ID>`) that actions use to target it.
 *
 * The document number keeps refs from a previous page from matching elements on
 * the current one, as node IDs can repeat across pages.
 */
export async function captureSnapshot(
  cdp: Cdp,
  document: number,
): Promise<string> {
  const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
    "Accessibility.getFullAXTree",
  );
  const root = nodes.find((node) => !node.parentId);
  if (!root) {
    return "";
  }
  const lines: string[] = [];
  renderItems(buildItems(root, nodes, `d${document}e`), "", lines);
  return lines.join("\n");
}

export function parseRef(ref: string): {
  document: number;
  backendNodeId: number;
} {
  const match = /^d(\d+)e(\d+)$/.exec(ref.trim());
  if (!match) {
    throw new Error(
      `Invalid element ref "${ref}". Use a ref from the latest page snapshot, like "d1e12".`,
    );
  }
  return { document: Number(match[1]), backendNodeId: Number(match[2]) };
}

function buildItems(root: AXNode, nodes: AXNode[], refPrefix: string): Item[] {
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const visited = new Set([root.nodeId]);

  const buildChildren = (node: AXNode): Item[] =>
    mergeText(
      (node.childIds ?? []).flatMap((id) => {
        const child = nodesById.get(id);
        if (!child || visited.has(id)) {
          return [];
        }
        visited.add(id);
        return buildNode(child);
      }),
    );

  const buildNode = (node: AXNode): Item[] => {
    const role = String(node.role?.value ?? "");
    if (skippedRoles.has(role)) {
      return [];
    }
    if (role === "LineBreak") {
      return [" "];
    }
    if (role === "StaticText") {
      // Whitespace is kept until the text is joined up, as a page can split
      // words across elements, down to one element per character
      const text = collapseWhitespace(node.name?.value);
      return text ? [text] : [];
    }
    const rawChildren = buildChildren(node);
    if (node.ignored) {
      return rawChildren;
    }
    const displayRole = roleNames[role] ?? role;
    const name = layoutRoles.has(role) ? "" : normalizeText(node.name?.value);
    const children = tidyText(rawChildren);

    const isTextOnly = children.length === 1 && typeof children[0] === "string";
    if (
      wrapperRoles.has(displayRole) &&
      !name &&
      propertyValue(node, "focusable") !== true &&
      !isTextOnly
    ) {
      // Text-only wrappers are kept, as they're often clickable, e.g. <div>Save</div>.
      // Wrappers are usually blocks, so their text mustn't run into a neighbor's.
      return [" ", ...rawChildren, " "];
    }

    const isField = fieldRoles.has(role);
    return [
      {
        role: displayRole,
        name,
        attributes: attributesOf(node),
        ref: node.backendDOMNodeId
          ? `${refPrefix}${node.backendDOMNodeId}`
          : undefined,
        value: isField ? normalizeText(node.value?.value) || undefined : undefined,
        url:
          role === "link"
            ? normalizeText(propertyValue(node, "url")) || undefined
            : undefined,
        // A field's text children repeat its value or placeholder
        children: simplifyChildren(
          isField ? children.filter((child) => typeof child !== "string") : children,
          name,
        ),
      },
    ];
  };

  return tidyText(buildChildren(root));
}

function simplifyChildren(children: Item[], name: string): Item[] {
  const [only] = children;
  if (children.length === 1 && isTextWrapper(only)) {
    // <button><span>Save</span></button>: the span adds nothing
    return simplifyChildren(only.children, name);
  }
  if (children.length === 1 && only === name) {
    return [];
  }
  return children;
}

function isTextWrapper(item: Item | undefined): item is SnapshotElement {
  return (
    typeof item === "object" &&
    wrapperRoles.has(item.role) &&
    !item.name &&
    item.attributes.length === 0 &&
    item.children.length === 1 &&
    typeof item.children[0] === "string"
  );
}

/** Joins adjacent text the way the browser renders inline text: as is. */
function mergeText(items: Item[]): Item[] {
  const merged: Item[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (typeof item === "string" && typeof last === "string") {
      merged[merged.length - 1] = last + item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

/** Trims an element's text children and drops the ones that are only whitespace. */
function tidyText(items: Item[]): Item[] {
  return items
    .map((item) => (typeof item === "string" ? normalizeText(item) : item))
    .filter((item) => item !== "");
}

function attributesOf(node: AXNode): string[] {
  const attributes: string[] = [];
  const role = String(node.role?.value ?? "");
  const level = propertyValue(node, "level");
  if (role === "heading" && level !== undefined) {
    attributes.push(`level=${level}`);
  }
  for (const state of ["checked", "pressed"]) {
    const value = propertyValue(node, state);
    if (value === true || value === "true") {
      attributes.push(state);
    } else if (value === "mixed") {
      attributes.push(`${state}=mixed`);
    }
  }
  for (const flag of ["expanded", "selected", "disabled", "focused", "required"]) {
    if (propertyValue(node, flag) === true) {
      attributes.push(flag);
    }
  }
  // Marks the root of a contenteditable region; everything inside it is editable too
  if (
    propertyValue(node, "editable") !== undefined &&
    propertyValue(node, "focusable") === true &&
    !fieldRoles.has(role)
  ) {
    attributes.push("editable");
  }
  return attributes;
}

function propertyValue(node: AXNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value
    .value;
}

function normalizeText(value: unknown): string {
  return collapseWhitespace(value).trim();
}

function collapseWhitespace(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  return String(value).replace(/\s+/g, " ");
}

function renderItems(items: Item[], indent: string, lines: string[]) {
  for (const item of items) {
    if (typeof item === "string") {
      lines.push(`${indent}- text: ${item}`);
      continue;
    }

    let line = `${indent}- ${item.role}`;
    if (item.name) {
      line += ` ${JSON.stringify(item.name)}`;
    }
    for (const attribute of item.attributes) {
      line += ` [${attribute}]`;
    }
    if (item.ref) {
      line += ` [ref=${item.ref}]`;
    }

    const inline = inlineText(item);
    if (inline) {
      lines.push(`${line}: ${inline}`);
    } else if (!item.url && item.children.length === 0) {
      lines.push(line);
    } else {
      lines.push(`${line}:`);
      if (item.url) {
        lines.push(`${indent}  - /url: ${item.url}`);
      }
      renderItems(item.children, `${indent}  `, lines);
    }
  }
}

function inlineText(element: SnapshotElement): string | undefined {
  if (element.url) {
    return undefined;
  }
  if (element.children.length === 0) {
    return element.value;
  }
  const [only] = element.children;
  return element.children.length === 1 && typeof only === "string"
    ? only
    : undefined;
}
