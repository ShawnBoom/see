import assert from "node:assert/strict";
import test from "node:test";
import "./install-file-fetch.mjs";
import { hasEdits, visibleEditLabel } from "../lib/edit-state.js";
import {
  createNeutralEdit,
  processPixels,
} from "../lib/image-engine.js";
import { loadFilterLut } from "../lib/lut-loader.js";

await Promise.all([
  "classic", "gold", "youth", "slot04", "slot05", "slot06", "slot07",
  "slot08", "slot09", "slot10", "slot11", "slot12", "slot13", "slot14",
].map((filter) => loadFilterLut(filter)));

const source = {
  width: 3,
  height: 2,
  data: new Uint8ClampedArray([
    18, 42, 90, 255,
    210, 120, 60, 255,
    245, 230, 205, 255,
    28, 190, 130, 255,
    120, 78, 170, 255,
    252, 252, 252, 255,
  ]),
};

function changed(result) {
  return Array.from(result).some((value, index) => value !== source.data[index]);
}

test("Original and Edited labels describe the currently visible image", () => {
  const original = createNeutralEdit();
  assert.equal(hasEdits(original), false);
  assert.equal(visibleEditLabel(original, false), "Original");

  const edits = [
    { ...original, filter: "classic" },
    { ...original, strength: 75 },
    { ...original, brightness: 1 },
    { ...original, color: -1 },
    { ...original, grain: 1 },
  ];
  for (const edit of edits) {
    assert.equal(hasEdits(edit), true);
    assert.equal(visibleEditLabel(edit, false), "Edited");
    assert.equal(visibleEditLabel(edit, true), "Original");
    assert.deepEqual(edit, { ...edit });
  }
});

test("neutral edit is an exact pixel no-op", () => {
  assert.deepEqual(processPixels(source, createNeutralEdit(), 42), source.data);
});

test("preset strength zero restores the exact original", () => {
  const edit = { filter: "gold", strength: 0, brightness: 0, color: 0, grain: 0 };
  assert.deepEqual(processPixels(source, edit, 42), source.data);
});

test("the NN slot uses the provided 33-point Nostalgic Neg LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "classic", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    4, 3, 3, 255,
    247, 248, 242, 255,
  ]));
});

test("the NC slot uses the provided 33-point Classic Neg LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "gold", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    6, 6, 6, 255,
    250, 252, 250, 255,
  ]));
});

test("the CC slot uses the provided 33-point Classic Chrome LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "youth", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    0, 0, 0, 255,
    247, 253, 245, 255,
  ]));
});

test("the Pro400H slot uses the provided 33-point 400H LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot04", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    14, 23, 7, 255,
    255, 252, 249, 255,
  ]));
});

test("the Sup400 slot uses the provided 33-point Superia 400 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot05", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    2, 14, 12, 255,
    250, 249, 250, 255,
  ]));
});

test("the Color100 slot uses the provided 33-point Color 100 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot06", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    0, 16, 17, 255,
    248, 254, 254, 255,
  ]));
});

test("the Color800Z slot uses the provided 33-point Color 800Z LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot07", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    1, 16, 17, 255,
    250, 250, 249, 255,
  ]));
});

test("the Gold Blue slot uses the provided 64-point Kodak Gold Master Blue LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot08", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    1, 1, 1, 255,
    234, 239, 243, 255,
  ]));
});

test("the Portra Cool slot uses the provided 64-point Portra Cool LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot09", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    0, 1, 1, 255,
    252, 249, 240, 255,
  ]));
});

test("the Proimage Original slot uses the provided 25-point Proimage100 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot10", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    21, 23, 20, 255,
    250, 250, 252, 255,
  ]));
});

test("the Ektar 100 slot uses the provided 64-point Kodak Ektar 100 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot11", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    0, 0, 0, 255,
    254, 254, 254, 255,
  ]));
});

test("the Portra 400 slot uses the provided 64-point Kodak Portra 400 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot12", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    10, 12, 6, 255,
    248, 244, 246, 255,
  ]));
});

test("the Gold 200 slot uses the provided 64-point Kodak Gold200 3 LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot13", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    2, 2, 1, 255,
    250, 245, 247, 255,
  ]));
});

test("the Chrome 64 slot uses the provided 64-point Kodak Chrome LUT", () => {
  const endpoints = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
  };
  const result = processPixels(
    endpoints,
    { filter: "slot14", strength: 100, brightness: 0, color: 0, grain: 0 },
    42,
  );

  assert.deepEqual(result, new Uint8ClampedArray([
    0, 0, 0, 255,
    252, 251, 251, 255,
  ]));
});

test("preset strength does not scale later manual adjustments", () => {
  const withPresetAtZero = {
    filter: "classic",
    strength: 0,
    brightness: 22,
    color: -15,
    grain: 0,
  };
  const withoutPreset = { ...withPresetAtZero, filter: null };
  assert.deepEqual(
    processPixels(source, withPresetAtZero, 42),
    processPixels(source, withoutPreset, 42),
  );
});

test("brightness and perceptual color controls respond across their full ranges", () => {
  const bright = processPixels(
    source,
    { filter: null, strength: 100, brightness: 100, color: 0, grain: 0 },
    42,
  );
  const dark = processPixels(
    source,
    { filter: null, strength: 100, brightness: -100, color: 0, grain: 0 },
    42,
  );
  const monochrome = processPixels(
    source,
    { filter: null, strength: 100, brightness: 0, color: -100, grain: 0 },
    42,
  );

  assert.ok(changed(bright));
  assert.ok(changed(dark));
  assert.ok(bright[0] > source.data[0]);
  assert.ok(dark[0] < source.data[0]);
  for (let index = 0; index < monochrome.length; index += 4) {
    assert.ok(Math.max(monochrome[index], monochrome[index + 1], monochrome[index + 2])
      - Math.min(monochrome[index], monochrome[index + 1], monochrome[index + 2]) <= 1);
  }
});

test("Grain is neutral at zero, seed-stable, reversible, and random per import", () => {
  const edit = { filter: null, strength: 100, brightness: 0, color: 0, grain: 65 };
  const first = processPixels(source, edit, 123);
  const second = processPixels(source, edit, 123);
  const otherPhoto = processPixels(source, edit, 987);
  const lowFirst = processPixels(source, { ...edit, grain: 20 }, 123);
  processPixels(source, { ...edit, grain: 50 }, 123);
  const lowAgain = processPixels(source, { ...edit, grain: 20 }, 123);

  assert.deepEqual(first, second);
  assert.deepEqual(lowFirst, lowAgain);
  assert.ok(changed(first));
  assert.notDeepEqual(first, otherPhoto);
  assert.deepEqual(
    processPixels(source, { ...edit, grain: 0 }, 123),
    source.data,
  );
});
