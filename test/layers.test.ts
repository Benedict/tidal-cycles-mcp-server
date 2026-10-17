import { test } from "node:test";
import assert from "node:assert/strict";
import { composePattern, removeLayer, setLayer, Layer } from "../src/layers.js";
import { Autopilot, mutateLayer } from "../src/autopilot.js";

function build(...inputs: Array<Parameters<typeof setLayer>[1]>): Layer[] {
  return inputs.reduce<Layer[]>((layers, input) => setLayer(layers, input), []);
}

test("composes transforms, source and controls in order", () => {
  const layers = build(
    { name: "beat", kind: "source", code: 's "bd*2 sd"' },
    { name: "every", kind: "transform", code: "every 3 (jux rev)" },
    { name: "crush", kind: "control", code: "crush 4" },
    { name: "chop", kind: "transform", code: "chop 4" },
    { name: "n", kind: "control", code: 'n "0 1"' }
  );
  assert.equal(composePattern(layers), 'every 3 (jux rev) $ chop 4 $ s "bd*2 sd" # crush 4 # n "0 1"');
});

test("groups code containing $ so it doesn't swallow what follows", () => {
  const layers = build(
    { name: "src", kind: "source", code: 'slow 2 $ s "bd"' },
    { name: "pan", kind: "control", code: "pan $ slow 4 sine" }
  );
  assert.equal(composePattern(layers), '(slow 2 $ s "bd") # (pan $ slow 4 sine)');
});

test("leaves out laid-out layers", () => {
  const layers = build(
    { name: "src", kind: "source", code: 's "bd"' },
    { name: "rev", kind: "transform", code: "rev" }
  );
  layers[1].enabled = false;
  assert.equal(composePattern(layers), 's "bd"');
});

test("replacing a layer keeps its position", () => {
  let layers = build(
    { name: "src", kind: "source", code: 's "bd"' },
    { name: "a", kind: "transform", code: "rev" },
    { name: "b", kind: "transform", code: "fast 2" }
  );
  layers = setLayer(layers, { name: "a", kind: "transform", code: "chop 4" });
  assert.equal(composePattern(layers), 'chop 4 $ fast 2 $ s "bd"');
});

test("a new source replaces the old one", () => {
  const layers = build(
    { name: "one", kind: "source", code: 's "bd"' },
    { name: "two", kind: "source", code: 's "sn"' }
  );
  assert.deepEqual(layers.map((l) => l.name), ["two"]);
});

test("variants always include the current code, without duplicates", () => {
  const [layer] = build({ name: "src", kind: "source", code: 's "bd"', variants: ['s "sn"', 's "bd"', " "] });
  assert.deepEqual(layer.variants, ['s "bd"', 's "sn"']);
});

test("refuses to remove the source while other layers remain", () => {
  const layers = build(
    { name: "src", kind: "source", code: 's "bd"' },
    { name: "rev", kind: "transform", code: "rev" }
  );
  assert.throws(() => removeLayer(layers, "src"), /source layer/);
  assert.deepEqual(removeLayer(removeLayer(layers, "rev"), "src"), []);
});

test("mutateLayer lays out a transform when the roll is under the chance", () => {
  const [layer] = build({ name: "rev", kind: "transform", code: "rev" });
  assert.equal(mutateLayer(layer, 0.5, () => 0.1), true);
  assert.equal(layer.enabled, false);
  // Next change brings it back
  assert.equal(mutateLayer(layer, 0.5, () => 0.9), true);
  assert.equal(layer.enabled, true);
});

test("mutateLayer switches to a different variant", () => {
  const [layer] = build({ name: "src", kind: "source", code: "a", variants: ["b", "c"] });
  mutateLayer(layer, 1, () => 0.99);
  assert.equal(layer.code, "c");
  assert.equal(layer.enabled, true);
});

test("mutateLayer never lays out a source", () => {
  const [layer] = build({ name: "src", kind: "source", code: "a" });
  assert.equal(mutateLayer(layer, 1, () => 0), false);
  assert.equal(layer.enabled, true);
});

test("autopilot changes layers on their timers, and pause stops it", async () => {
  const layers = new Map([["d1", build({ name: "src", kind: "source", code: "a", variants: ["b"] })]]);
  const changes: string[] = [];
  const autopilot = new Autopilot(
    () => layers,
    async (_channel, layer) => {
      changes.push(layer.code);
    }
  );

  autopilot.start({ minSeconds: 0.01, maxSeconds: 0.01, layOutChance: 0 });
  assert.equal(autopilot.activeLayerCount(), 1);
  await new Promise((r) => setTimeout(r, 80));
  autopilot.pause();
  const count = changes.length;
  assert.ok(count >= 2, `expected several changes, got ${count}`);
  assert.deepEqual(changes.slice(0, 2), ["b", "a"]);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(changes.length, count);
  assert.equal(autopilot.status, "paused");
});

test("autopilot ignores layers that can't change and drops removed ones", () => {
  const layers = new Map([["d1", build({ name: "src", kind: "source", code: "a" })]]);
  const autopilot = new Autopilot(() => layers, async () => {});
  autopilot.start({ minSeconds: 1, maxSeconds: 1, layOutChance: 0.5 });
  assert.equal(autopilot.activeLayerCount(), 0);

  layers.set("d1", setLayer(layers.get("d1")!, { name: "rev", kind: "transform", code: "rev" }));
  autopilot.sync();
  assert.equal(autopilot.activeLayerCount(), 1);

  layers.delete("d1");
  autopilot.sync();
  assert.equal(autopilot.activeLayerCount(), 0);
  autopilot.stop();
});

test("autopilot rejects bad settings", () => {
  const autopilot = new Autopilot(() => new Map(), async () => {});
  assert.throws(() => autopilot.start({ minSeconds: 5, maxSeconds: 1 }), /maxSeconds/);
  assert.throws(() => autopilot.start({ layOutChance: 2 }), /layOutChance/);
});
