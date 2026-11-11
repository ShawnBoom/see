import assert from "node:assert/strict";
import test from "node:test";
import { lightPort, grainPort } from "../lib/openlight-port.js";
import { colorPort } from "../lib/lightcraft-color.js";
import { grainFieldAt, grainFootprint } from "../lib/film-grain-port.js";

test("OpenLight ports preserve the neutral inputs and channel ratios for exposure and grain", () => {
  const rgb = [0.67, 0.31, 0.12];
  assert.deepEqual(lightPort(...rgb, 0), rgb);
  assert.deepEqual(colorPort(...rgb, 0), rgb);
  for (const output of [lightPort(...rgb, 1), lightPort(...rgb, -1), grainPort(...rgb, 1, 0.75)]) {
    assert.ok(output.every(channel => channel >= 0 && channel <= 1));
    assert.ok(Math.abs(output[0] / output[1] - rgb[0] / rgb[1]) < 1e-10);
  }
  const gray = colorPort(...rgb, -1);
  assert.ok(Math.max(...gray)-Math.min(...gray)<.001);
});

test("Grain uses a stable seeded field in image coordinates and scales only the footprint", () => {
  const footprint = grainFootprint(640, 960);
  assert.equal(grainFootprint(1280, 1920), footprint / 2);
  const a = grainFieldAt(123, 234, footprint, 1234, 640, 960);
  assert.equal(grainFieldAt(123, 234, footprint, 1234, 640, 960), a);
  assert.notEqual(grainFieldAt(123, 234, footprint, 5678, 640, 960), a);
  const rgb = [0.25, 0.25, 0.25];
  const changes = [0, 0.25, 0.5, 0.75, 1].map(amount => Math.abs(grainPort(...rgb, amount, a)[0] - rgb[0]));
  assert.ok(changes[0] < 1e-12);
  assert.ok(changes.slice(1).every((value, index) => value > changes[index]));
});
