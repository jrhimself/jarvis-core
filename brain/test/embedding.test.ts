/**
 * Vectors in and out of SQLite.
 *
 * The model itself is not exercised here — loading it costs four seconds and
 * half a gigabyte, and what breaks in practice is not the arithmetic of the
 * model but the trip through a BLOB column. A vector that comes back misaligned
 * scores every fact against every other one and nothing looks wrong until
 * recall quietly returns nonsense.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBlob, similarity, toBlob } from "../dist/memory/embedding.js";

test("a vector survives the round trip through a blob", () => {
  const vector = Float32Array.from([0.5, -0.25, 0, 1]);

  const restored = fromBlob(toBlob(vector));

  assert.deepEqual([...restored], [...vector]);
  assert.equal(toBlob(vector).byteLength, 16, "four floats of four bytes");
});

test("a blob sitting inside a larger buffer reads only its own bytes", () => {
  const vector = Float32Array.from([1, 2, 3, 4]);
  const padded = new Uint8Array(24);
  padded.set(toBlob(vector), 8);

  const restored = fromBlob(padded.subarray(8, 24));

  assert.deepEqual([...restored], [1, 2, 3, 4]);
});

test("copies are made, so a stored vector does not move when the original does", () => {
  const vector = Float32Array.from([1, 2]);
  const blob = toBlob(vector);
  vector[0] = 99;

  assert.deepEqual([...fromBlob(blob)], [1, 2]);
});

test("similarity of unit vectors is a dot product", () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([0, 1, 0]);

  assert.equal(similarity(a, a), 1, "a thing is identical to itself");
  assert.equal(similarity(a, b), 0, "and unrelated to a perpendicular one");
  assert.equal(similarity(a, Float32Array.from([-1, 0, 0])), -1);

  const diagonal = Float32Array.from([Math.SQRT1_2, Math.SQRT1_2, 0]);
  assert.ok(Math.abs(similarity(a, diagonal) - Math.SQRT1_2) < 1e-6);
});

test("vectors of different lengths score zero rather than throwing", () => {
  assert.equal(similarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0);
  assert.equal(similarity(new Float32Array(0), new Float32Array(0)), 0);
});
