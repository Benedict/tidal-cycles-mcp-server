/**
 * Layered channel model.
 *
 * A channel can be built from named layers instead of a single pattern string:
 *
 *   transforms   every 3 (jux rev) $ chop 4 $
 *   source       s "bd*2 [~ sd] hh*3"
 *   controls     # n "0 .. 3" # crush 4
 *
 * Each layer can be edited, removed or laid out on its own, and can carry
 * variants for the autopilot to choose between.
 */

export type LayerKind = "transform" | "source" | "control";

export const LAYER_KINDS: LayerKind[] = ["transform", "source", "control"];

export interface Layer {
  name: string;
  kind: LayerKind;
  /** The code currently in use */
  code: string;
  /** Alternatives the autopilot may switch between; always includes `code` */
  variants: string[];
  /** False when the layer has been laid out */
  enabled: boolean;
}

// `$` has the lowest precedence in Haskell, so code containing it would swallow
// whatever follows when spliced into a larger expression.
function group(code: string): string {
  return code.includes("$") ? `(${code})` : code;
}

/**
 * Builds the pattern for a channel from its layers. Transforms apply outermost
 * first, in the order they were added, and wrap the source and its controls.
 */
export function composePattern(layers: Layer[]): string {
  const active = layers.filter((l) => l.enabled);
  const source = active.find((l) => l.kind === "source");
  if (!source) {
    throw new Error("Channel has no source layer");
  }

  const transforms = active
    .filter((l) => l.kind === "transform")
    .map((l) => `${l.code} $ `)
    .join("");
  const controls = active
    .filter((l) => l.kind === "control")
    .map((l) => ` # ${group(l.code)}`)
    .join("");

  const body = controls ? group(source.code) : source.code;
  return `${transforms}${body}${controls}`;
}

/**
 * Adds or replaces a layer. A channel has at most one source, so setting a
 * source layer replaces any existing one. Replacing a layer keeps its position.
 */
export function setLayer(
  layers: Layer[],
  input: { name: string; kind: LayerKind; code: string; variants?: string[] }
): Layer[] {
  const code = input.code.trim();
  if (code === "") {
    throw new Error("Layer code must be a non-empty string");
  }
  const variants = Array.from(
    new Set([code, ...(input.variants ?? []).map((v) => v.trim()).filter(Boolean)])
  );
  const layer: Layer = { name: input.name, kind: input.kind, code, variants, enabled: true };

  const others = input.kind === "source"
    ? layers.filter((l) => l.kind !== "source" || l.name === input.name)
    : layers;
  const index = others.findIndex((l) => l.name === input.name);
  if (index === -1) {
    return [...others, layer];
  }
  return others.map((l, i) => (i === index ? layer : l));
}

export function removeLayer(layers: Layer[], name: string): Layer[] {
  const target = layers.find((l) => l.name === name);
  if (!target) {
    throw new Error(`No layer named "${name}"`);
  }
  const remaining = layers.filter((l) => l.name !== name);
  if (target.kind === "source" && remaining.length > 0) {
    throw new Error(
      `Can't remove the source layer while other layers remain. Set a new source instead, or remove the other layers first.`
    );
  }
  return remaining;
}

export function describeLayers(layers: Layer[]): string {
  return layers
    .map((l) => {
      const state = l.enabled ? "" : " (laid out)";
      const variants = l.variants.length > 1 ? ` [${l.variants.length} variants]` : "";
      return `    ${l.kind} "${l.name}": ${l.code}${variants}${state}`;
    })
    .join("\n");
}
