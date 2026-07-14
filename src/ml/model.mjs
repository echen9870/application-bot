/**
 * model.mjs — logistic-regression head over the named features in features.mjs.
 *
 * Learns "will Eric apply to this job?" from apply.mjs outcomes: each Potential row
 * moved to Applied is a positive (1), each moved to Ignored a negative (0). Input is
 * the 9-dim named-feature vector (see src/ml/features.mjs FEATURE_NAMES), so every
 * learned weight is directly interpretable.
 *
 * Trained with plain gradient descent + L2 regularization; positives are upweighted
 * by nNeg/nPos so the (typically rare) applied class isn't drowned out. Training can
 * warm-start from the hand-tuned prior (DEFAULT_MODEL) via the init option.
 *
 * Storage: data/model.json  { weights: number[9], bias, meta: { trainedAt, nPos, nNeg, features } }
 * Writes are atomic (tmp + rename), same pattern as descriptions.mjs.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const MODEL_PATH = 'data/model.json';

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Train a logistic-regression classifier.
 * @param {number[][]} X  feature vectors (unit-norm embeddings)
 * @param {number[]}   y  labels, 0 or 1
 * @returns {{ weights: number[], bias: number, meta: { trainedAt, nPos, nNeg } }}
 */
export function trainLogistic(X, y, { epochs = 300, lr = 0.1, lambda = 0.01, init } = {}) {
  if (X.length === 0 || X.length !== y.length) throw new Error('trainLogistic: bad training set');
  const dim  = X[0].length;
  const nPos = y.filter(v => v === 1).length;
  const nNeg = y.length - nPos;
  if (nPos === 0 || nNeg === 0) throw new Error('trainLogistic: need both classes');

  // Upweight the minority positive class so imbalanced data still learns it.
  const posWeight = nNeg / nPos;

  // Optional warm start from a prior model (e.g. the hand-tuned DEFAULT_MODEL in
  // features.mjs) — with few labels the result stays close to the prior.
  const weights = init?.weights?.length === dim ? [...init.weights] : new Array(dim).fill(0);
  let bias = init && typeof init.bias === 'number' ? init.bias : 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      let z = bias;
      for (let d = 0; d < dim; d++) z += weights[d] * x[d];
      const w   = y[i] === 1 ? posWeight : 1;
      const err = (sigmoid(z) - y[i]) * w;
      for (let d = 0; d < dim; d++) gradW[d] += err * x[d];
      gradB += err;
    }
    const n = X.length;
    for (let d = 0; d < dim; d++) {
      weights[d] -= lr * (gradW[d] / n + lambda * weights[d]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias, meta: { trainedAt: new Date().toISOString(), nPos, nNeg } };
}

/**
 * Honest skill estimate via a stratified 80/20 holdout.
 *
 * Training accuracy is misleading here: with ~4% positives, always predicting
 * "ignore" scores ~96%. What matters is precision/recall on the positive
 * (applied) class, measured on examples the model never saw. Trains a throwaway
 * model on 80% (stratified so both classes appear in both splits, shuffled with
 * a seeded PRNG for reproducible runs) and evaluates on the held-out 20%.
 *
 * @returns {{ precision, recall, nTestPos, nTestNeg } | null}  null if a class
 *          is too small to split meaningfully (< 5 examples).
 */
export function evaluateHoldout(X, y, { testFrac = 0.2, seed = 42, threshold = 0.5, trainOpts = {} } = {}) {
  const posIdx = [], negIdx = [];
  y.forEach((v, i) => (v === 1 ? posIdx : negIdx).push(i));
  if (posIdx.length < 5 || negIdx.length < 5) return null;

  // Seeded shuffle (mulberry32) so repeated runs report the same numbers
  let s = seed;
  const rand = () => ((s = (s + 0x6D2B79F5) | 0), (((s ^ (s >>> 15)) * (1 | s)) >>> 0) / 4294967296);
  for (const arr of [posIdx, negIdx]) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  const nTestPos = Math.max(1, Math.floor(posIdx.length * testFrac));
  const nTestNeg = Math.max(1, Math.floor(negIdx.length * testFrac));
  const testSet  = new Set([...posIdx.slice(0, nTestPos), ...negIdx.slice(0, nTestNeg)]);

  const trainX = [], trainY = [];
  for (let i = 0; i < X.length; i++) if (!testSet.has(i)) { trainX.push(X[i]); trainY.push(y[i]); }
  const model = trainLogistic(trainX, trainY, trainOpts);

  let tp = 0, fp = 0, fn = 0;
  for (const i of testSet) {
    const pred = predictLogistic(model, X[i]) >= threshold ? 1 : 0;
    if (pred === 1 && y[i] === 1) tp++;
    else if (pred === 1 && y[i] === 0) fp++;
    else if (pred === 0 && y[i] === 1) fn++;
  }
  return {
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall:    tp + fn === 0 ? 0 : tp / (tp + fn),
    nTestPos, nTestNeg,
  };
}

/** Predicted probability (0–1) that the job with this embedding gets applied to. */
export function predictLogistic(model, embedding) {
  let z = model.bias;
  for (let d = 0; d < model.weights.length; d++) z += model.weights[d] * embedding[d];
  return sigmoid(z);
}

/** Persist the model atomically to data/model.json. */
export function saveModel(model) {
  mkdirSync(dirname(MODEL_PATH), { recursive: true });
  const tmp = `${MODEL_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(model), 'utf-8');
  renameSync(tmp, MODEL_PATH);
}

/**
 * Load the trained model, or null if none exists (scorer then uses DEFAULT_MODEL's
 * prior weights). Requires meta.features naming each weight — legacy 384-dim
 * embedding models (pre feature-model) lack it and are deliberately ignored.
 */
export function loadModel() {
  if (!existsSync(MODEL_PATH)) return null;
  try {
    const m = JSON.parse(readFileSync(MODEL_PATH, 'utf-8'));
    const valid = Array.isArray(m?.weights) && typeof m?.bias === 'number'
      && Array.isArray(m?.meta?.features) && m.meta.features.length === m.weights.length;
    return valid ? m : null;
  } catch {
    return null;
  }
}
