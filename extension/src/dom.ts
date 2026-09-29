import type { Cdp } from "./cdp";
import type { Point } from "./input";

type ExceptionDetails = { text: string; exception?: { description?: string } };

type EvaluationResult = {
  result: { value?: unknown };
  exceptionDetails?: ExceptionDetails;
};

type LayoutMetrics = {
  cssLayoutViewport: { clientWidth: number; clientHeight: number };
};

const staleElementError =
  "Element no longer exists on the page. Take a new snapshot to get fresh element refs.";

export async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const { result, exceptionDetails } = await cdp.send<EvaluationResult>(
    "Runtime.evaluate",
    { expression, returnByValue: true },
  );
  if (exceptionDetails) {
    throw new Error(describeException(exceptionDetails));
  }
  return result.value as T;
}

/**
 * Runs `fn` in the page with the element as `this`. `fn` is sent as source code,
 * so it must not reference anything outside its own body.
 */
export async function callFunction<T>(
  cdp: Cdp,
  objectId: string,
  fn: (...args: never[]) => unknown,
  args: unknown[] = [],
): Promise<T> {
  const { result, exceptionDetails } = await cdp.send<EvaluationResult>(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
  );
  if (exceptionDetails) {
    throw new Error(describeException(exceptionDetails));
  }
  return result.value as T;
}

export async function resolveObjectId(
  cdp: Cdp,
  backendNodeId: number,
): Promise<string> {
  const { object } = await cdp
    .send<{ object: { objectId?: string } }>("DOM.resolveNode", {
      backendNodeId,
    })
    .catch(() => ({ object: { objectId: undefined } }));
  if (!object.objectId) {
    throw new Error(staleElementError);
  }
  return object.objectId;
}

export async function scrollIntoView(cdp: Cdp, backendNodeId: number) {
  try {
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Elements without a layout can't be scrolled to; callers report them as not visible
  }
}

/** Scrolls the element into view and returns the center of its first visible box. */
export async function clickablePoint(
  cdp: Cdp,
  backendNodeId: number,
): Promise<Point> {
  await scrollIntoView(cdp, backendNodeId);
  const [quads, metrics] = await Promise.all([
    contentQuads(cdp, backendNodeId),
    cdp.send<LayoutMetrics>("Page.getLayoutMetrics"),
  ]);
  const { clientWidth, clientHeight } = metrics.cssLayoutViewport;
  for (const quad of quads) {
    const points = [0, 2, 4, 6].map((i) => ({
      x: clamp(quad[i], 0, clientWidth),
      y: clamp(quad[i + 1], 0, clientHeight),
    }));
    if (area(points) > 1) {
      return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    }
  }
  throw new Error(
    "Element is not visible, so it can't be interacted with. Take a new snapshot and pick a visible element.",
  );
}

async function contentQuads(cdp: Cdp, backendNodeId: number): Promise<number[][]> {
  try {
    const { quads } = await cdp.send<{ quads: number[][] }>(
      "DOM.getContentQuads",
      { backendNodeId },
    );
    return quads;
  } catch (error) {
    if (error instanceof Error && error.message.includes("No node")) {
      throw new Error(staleElementError);
    }
    // Chrome can't compute boxes for elements that aren't rendered
    return [];
  }
}

function describeException(details: ExceptionDetails): string {
  return details.exception?.description ?? details.text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Area of a polygon, using the shoelace formula. */
function area(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    sum += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(sum) / 2;
}
