import type { Cdp } from "./cdp";

export type Point = { x: number; y: number };

type KeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  location?: number;
};

const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

type Modifier = keyof typeof modifierBits;

const isMac = navigator.userAgent.includes("Mac");

const namedKeys: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 },
};
for (let i = 1; i <= 12; i++) {
  namedKeys[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

const aliases: Record<string, string> = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  spacebar: "Space",
  ctrl: "Control",
  cmd: "Meta",
  command: "Meta",
  option: "Alt",
  controlormeta: isMac ? "Meta" : "Control",
};

/** Windows virtual key codes for US-layout punctuation keys. */
const punctuationKeyCodes: Record<string, number> = {
  ";": 186,
  "=": 187,
  ",": 188,
  "-": 189,
  ".": 190,
  "/": 191,
  "`": 192,
  "[": 219,
  "\\": 220,
  "]": 221,
  "'": 222,
};

/** macOS handles editing shortcuts outside the page, so they need explicit commands. */
const macEditingCommands: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
};

export async function hover(cdp: Cdp, point: Point) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
}

export async function mouseDown(cdp: Cdp, point: Point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
}

export async function mouseUp(cdp: Cdp, point: Point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function click(cdp: Cdp, point: Point) {
  await hover(cdp, point);
  await mouseDown(cdp, point);
  await mouseUp(cdp, point);
}

/** Moves the mouse in steps with the left button held, so drag handlers see the movement. */
export async function dragMouse(cdp: Cdp, from: Point, to: Point, steps = 10) {
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
      button: "left",
      buttons: 1,
    });
  }
}

/** Presses a key or a combination such as `Shift+Tab` or `Control+a`. */
export async function pressKey(cdp: Cdp, combo: string) {
  const { modifiers, key } = parseCombo(combo);
  const pressed: Modifier[] = [];
  let bits = 0;
  try {
    for (const modifier of modifiers) {
      bits |= modifierBits[modifier];
      pressed.push(modifier);
      await dispatchKey(cdp, "rawKeyDown", namedKeys[modifier], bits);
    }

    const shifted =
      bits & modifierBits.Shift && /^[a-z]$/.test(key.key)
        ? { ...key, key: key.key.toUpperCase(), text: key.key.toUpperCase() }
        : key;
    const isShortcut = (bits & ~modifierBits.Shift) !== 0;
    const text = isShortcut ? undefined : shifted.text;
    await cdp.send("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key: shifted.key,
      code: shifted.code,
      windowsVirtualKeyCode: shifted.keyCode,
      text,
      unmodifiedText: text,
      modifiers: bits,
      location: shifted.location,
      commands: editingCommands(bits, shifted),
    });
    await dispatchKey(cdp, "keyUp", shifted, bits);
  } finally {
    for (const modifier of pressed.reverse()) {
      bits &= ~modifierBits[modifier];
      await dispatchKey(cdp, "keyUp", namedKeys[modifier], bits);
    }
  }
}

async function dispatchKey(
  cdp: Cdp,
  type: "rawKeyDown" | "keyUp",
  key: KeyDefinition,
  modifiers: number,
) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
    location: key.location,
  });
}

function parseCombo(combo: string): { modifiers: Modifier[]; key: KeyDefinition } {
  const parts = combo.split("+");
  let keyName = parts.pop() ?? "";
  if (keyName === "" && parts.length > 0) {
    // "+" itself, alone or as in "Shift++"
    parts.pop();
    keyName = "+";
  }
  const modifiers = parts.map((part) => {
    const { key } = lookupKey(part);
    if (!(key in modifierBits)) {
      throw new Error(
        `"${part}" is not a modifier key. Use Shift, Control, Alt or Meta.`,
      );
    }
    return key as Modifier;
  });
  return { modifiers, key: lookupKey(keyName) };
}

function lookupKey(name: string): KeyDefinition {
  if ([...name].length === 1) {
    return characterKey(name);
  }
  const lower = name.toLowerCase();
  const canonical =
    aliases[lower] ??
    Object.keys(namedKeys).find((key) => key.toLowerCase() === lower);
  const definition = canonical ? namedKeys[canonical] : undefined;
  if (!definition) {
    throw new Error(
      `Unknown key "${name}". Use a key name like "Enter" or "ArrowDown", or a single character.`,
    );
  }
  return definition;
}

function characterKey(char: string): KeyDefinition {
  const upper = char.toUpperCase();
  if (/^[a-z]$/i.test(char)) {
    return { key: char, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: char };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char };
  }
  if (char === " ") {
    return namedKeys.Space;
  }
  return { key: char, code: "", keyCode: punctuationKeyCodes[char] ?? 0, text: char };
}

function editingCommands(bits: number, key: KeyDefinition): string[] | undefined {
  const withShift = modifierBits.Meta | modifierBits.Shift;
  if (!isMac || (bits !== modifierBits.Meta && bits !== withShift)) {
    return undefined;
  }
  const letter = key.key.toLowerCase();
  if (letter === "z" && bits === withShift) {
    return ["redo"];
  }
  const command = bits === modifierBits.Meta ? macEditingCommands[letter] : undefined;
  return command ? [command] : undefined;
}
