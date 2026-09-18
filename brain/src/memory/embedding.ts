/**
 * Sentence embeddings, computed in this process.
 *
 * Full-text search only finds a fact that shares words with the question. Ask
 * about the "wasdroger" when the fact says "droger" and it returns nothing, which
 * is precisely the case a memory is supposed to cover.
 *
 * The model is small and multilingual, runs on the CPU in single-digit
 * milliseconds, and needs no service of its own — which matters on a small
 * machine, where a separate inference server is the largest thing on it.
 * Measured: roughly 7 ms per sentence, 4 seconds to load, about half a
 * gigabyte resident, and it is downloaded on first start.
 *
 * English-only models were tried first and are useless for this: they rank
 * "droger" against "wasdroger" barely above an unrelated fact.
 */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

let loading: Promise<FeatureExtractionPipeline> | null = null;
let broken = false;

async function extractor(): Promise<FeatureExtractionPipeline | null> {
  if (broken) return null;
  loading ??= pipeline("feature-extraction", MODEL, { dtype: "q8" });
  try {
    return await loading;
  } catch (error) {
    console.error("embeddings unavailable, falling back to word search:", error);
    broken = true;
    loading = null;
    return null;
  }
}

/** Loads the model ahead of the first question. Never throws. */
export async function warmEmbeddings(): Promise<void> {
  await extractor();
}

/** A unit-length vector for the text, or null when embeddings are unavailable. */
export async function embed(text: string): Promise<Float32Array | null> {
  const model = await extractor();
  if (model === null) return null;
  try {
    const output = await model(text, { pooling: "mean", normalize: true });
    return Float32Array.from(output.data as Iterable<number>);
  } catch (error) {
    console.error("could not embed text:", error);
    return null;
  }
}

/** Cosine similarity of two unit vectors, so a plain dot product. */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0));
}

export function fromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
