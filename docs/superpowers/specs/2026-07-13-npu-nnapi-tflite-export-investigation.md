# NPU/NNAPI TFLite Export — Investigation Notes (Paused)

**Status:** PAUSED mid-investigation — root cause confirmed, fix attempt found unsafe, not resumed yet.
**Date:** 2026-07-13
**Author:** Dana + Claude
**Repos touched:** `~/engine_analysis` (model export, `train_anomaly_model.py`) and `~/flytab` (runtime, `InferenceEngine.java`)

**Read this before touching `export_tflite()` or the NNAPI delegate path again.** This picks up directly from `flytab/CLAUDE.md`'s existing "Delegate Selection on Snapdragon 8 Gen 3 (TB520FU)" note, which documents the symptom (NNAPI/GPU delegates rejected, silent fallback to CPU) as accepted/expected. Dana wants this actually fixed, not accepted — that's why this investigation exists.

---

## 1. Goal

Get NNAPI (and therefore the Lenovo tablet's NPU) to actually accept and run `anomaly_v2.tflite`, instead of silently falling back to CPU/XNNPACK. Must not silently fail — any fix must be verified for numerical correctness, not just "doesn't crash."

## 2. Root cause (confirmed, not hypothesis)

Inspected the currently-deployed float32 model's tensor `shape_signature` directly (`tf.lite.Interpreter.get_tensor_details()`): **every tensor in the graph has a dynamic batch dimension** (`shape_signature[0] == -1`), even though the *allocated* runtime shape is `[1, 60, 12]`. 41 of 91 tensors flagged dynamic in the current deployed model.

Cause: `build_autoencoder()` in `train_anomaly_model.py` uses `keras.Input(shape=(WINDOW_SIZE, n_features))`, which leaves the batch dimension unspecified (`None`) for training flexibility. `export_tflite()`'s `tf.lite.TFLiteConverter.from_keras_model(model)` preserves that dynamic batch dimension into the exported graph. NNAPI requires static-sized tensors, including the batch dimension — hence the existing documented rejection message (`flytab/CLAUDE.md`): `"static-sized tensors only, graph has dynamic tensors"`.

## 3. The INT8 model is not deployed — don't waste time fixing its conversion path

`export_tflite()` produces two files: `anomaly_v2.tflite` (INT8-quantized) and `anomaly_v2_float32.tflite`. Confirmed by checking the actual deployed asset: `flytab/android/app/src/main/assets/anomaly_v2.tflite` is 387,828 bytes — the **float32** model's size, not INT8's (~124-128KB). The deploy step (`engine_analysis/CLAUDE.md`) copies `anomaly_v2_float32.tflite` → `anomaly_v2.tflite` (renamed at copy time). The INT8 export is vestigial from the original v1 design (`flytab/docs/flytab-engine-ml-specs.md`, stale, describes INT8-on-NPU as the original intent, since abandoned for accuracy/compatibility — see `flytab` commit `791a5b2`). **Only the float32 export path in `export_tflite()` needs fixing.**

## 4. Fix attempted — DO NOT SHIP AS-IS

Standard TFLite pattern: build a fixed-batch (`[1, 60, 12]`) `tf.function` concrete function specifically for export, separate from the flexible-batch Keras model used for training:

```python
concrete_func = tf.function(lambda x: model(x)).get_concrete_function(
    tf.TensorSpec(shape=[1, WINDOW_SIZE, n_features], dtype=tf.float32)
)
converter_f32 = tf.lite.TFLiteConverter.from_concrete_functions([concrete_func], model)
tflite_f32 = converter_f32.convert()
```

**Verified this eliminates the dynamic-tensor problem structurally:** 0/109 dynamic tensors (vs. 41/91 today) on the real `build_autoencoder()` architecture, correct output shape, `interp.invoke()` runs without crashing.

**Verified this is numerically UNSAFE — do not ship:** compared the converted model's output against the same Keras model's own `.predict()` on identical input. The fixed-batch-converted model's output is **NaN**. The *current* code's conversion (`from_keras_model`, dynamic batch) produces correct, matching output on the same weights/input — confirmed the NaN is introduced by the concrete-function conversion approach specifically, not pre-existing. NaN anomaly scores would never trip `score > threshold` — this would silently and permanently disable anomaly detection if flown. This is exactly the kind of failure Dana explicitly said not to let happen silently.

Also tried wrapping in a `tf.Module` + `tf.saved_model.save()` with an explicit fixed-shape serving signature (the more "proper" pattern for variable freezing) — hit a *different* failure before even reaching the NaN check: `RuntimeError: ... READ_VARIABLE ... variable != nullptr was not true` during `converter.convert()` (this was while testing the INT8 quantization path specifically, which per §3 doesn't need fixing — but the same wrapping approach is a candidate worth retrying for the float32 path if the plain concrete-function approach can't be made numerically safe).

**Not yet done:** bisecting which specific layer/op introduces the NaN under `tf.function` tracing (suspect `UpSampling1D` — has known TFLite conversion quirks historically — but this is unconfirmed, not verified). Once isolated, the fix might be: a different (but still static-shape) conversion pattern, or replacing the suspect layer with an NNAPI/TFLite-friendlier equivalent (e.g. `Conv1DTranspose` instead of `UpSampling1D`+`Conv1D`) — the latter would be a real model-architecture change, bigger than this investigation started as.

## 5. Open decision (paused here)

Dana asked whether this needs a more capable model (Opus) than the session default (Sonnet) given the complexity. Agreed direction: the *mechanical* debugging (layer bisection, comparing outputs, running conversions) is well within Sonnet's demonstrated capability in this exact session — it's what caught the NaN issue before shipping it. The *architecture-level* judgment calls (deciding whether/how to change a layer, synthesizing the final safe approach, the final correctness review before any on-device test) warrant the most capable available model, same principle the `subagent-driven-development` skill already applies to "architecture and design tasks" and final reviews.

**Not yet decided:** whether to resume this immediately as its own scoped investigation (brainstorm → plan → implement, same rigor as Plan 1) or fold it into whatever comes after Plan 2. Dana said "step back and evaluate the architecture end to end" — leaning toward treating this as its own project, not a quick patch, given the NaN finding shows a naive fix is actively dangerous.

## 6. What must happen before this ships, regardless of approach

1. Bisect/confirm the exact cause of the NaN (don't guess which layer).
2. Find a conversion approach that is BOTH static-shape (0 dynamic tensors) AND numerically verified correct (compare against the Keras model's own output on real data, not just "doesn't crash").
3. Regenerate `anomaly_v2_float32.tflite` + `anomaly_v2_metadata.json` via the fixed export.
4. Deploy to the tablet and run the on-device CDP test (`flytab/CLAUDE.md` → EngineML Plugin → Deploying a New Model).
5. **Confirm NNAPI actually accepts it and engages the NPU** — check logcat for `InferenceEngine: NNAPI delegate loaded` (NPU active) vs. `Using CPU delegate` (still rejected) — per the log markers already documented in `flytab/CLAUDE.md`. Structural fix (0 dynamic tensors) is necessary but not sufficient proof — only the device confirms NNAPI actually accepts the resulting graph.
6. Also fix the unrelated-but-adjacent `'quantization': 'INT8'` metadata bug while in this code (`train_anomaly_model.py` — currently says INT8, should say FLOAT32 for the model that's actually deployed; confirmed harmless today only because `InferenceEngine.java` ignores this field and detects dtype from the loaded interpreter directly — see `flytab/CLAUDE.md`'s existing warning about this field "has been wrong before").

## 7. Related, already-complete work (don't re-do)

Plan 1 (offline phase-detection retrain pipeline rewrite, `~/engine_analysis`) is **fully complete** as of 2026-07-13 — see `engine_analysis/docs/superpowers/plans/2026-07-13-phase-detection-offline-retrain.md` and its progress ledger at `engine_analysis/.worktrees/phase-detection-offline-retrain/.superpowers/sdd/progress.md`. All 7 tasks done and reviewed, final whole-branch review done and fixed, a real end-to-end retrain succeeded (after finding and fixing an unrelated `sample_weight` shape bug — Keras `mse` loss on this model's 3D output reduces only over the feature axis, so `sample_weight` needs shape `(n, 60)` not `(n,)`). **The branch is not yet merged to `master`** — sitting on `phase-detection-offline-retrain` in `~/engine_analysis/.worktrees/phase-detection-offline-retrain`, clean, ready for `finishing-a-development-branch` when resumed. Plan 2 (runtime detector in `~/flytab`, per `docs/superpowers/specs/2026-06-21-flight-phase-detection-redesign.md`) has **not been started** — this NPU investigation was discovered as a side effect of verifying Plan 1's retrained model against the CLAUDE.md deploy checklist, before Plan 2 began.
