# Type Descriptor Correctness Foundation

## Goal

Define a precise, compositional theory for type descriptor propagation across pipeline steps, so correctness can be proven by local lemmas and composition rather than end-to-end case analysis.

This document does not prove correctness yet. It defines:

- the formal objects (descriptor model and path model),
- a semantic contract for what descriptors mean,
- transfer functions for each step type,
- proof obligations and composition theorems.

## Scope

The current implementation surface includes:

- `InputPipeline` in `src/factory.ts`
- step types in `src/steps`:
  - `FilterStep`
  - `DefinePropertyStep`
  - `DropPropertyStep`
  - `GroupByStep`
  - `CommutativeAggregateStep`
  - `AverageAggregateStep`
  - `MinMaxAggregateStep`
  - `PickByMinMaxStep`
- runtime descriptor consumers in `src/builder.ts` and path extraction in `src/pipeline.ts`.

## Descriptor Model

Define the descriptor type as a rooted tree:

- `TypeDescriptor = (rootCollectionName, rootNode)`
- `DescriptorNode = (arrays, collectionKey, scalars, mutableProperties?, objects?)`

where:

- `arrays` is a finite map from segment name to child node.
- `collectionKey` is an ordered list of scalar names used as logical key parts.
- `scalars` is a finite set/list of scalar descriptors.
- `mutableProperties` is an optional set/list of property names whose values may change after add.
- `objects` is an optional set/list of object descriptors, each `(name, node)`.

Path model:

- A descriptor path is a finite list of array segment names from root.
- A runtime key path is a finite list of keys that mirrors a descriptor path instance.

## Semantic Interpretation

Let `Sem(D)` be the set of runtime event traces and materialized states that are valid under descriptor `D`.

For proof planning, we use a weaker but tractable interpretation:

1. **Path soundness:** every emitted add/remove/modify event path corresponds to some descriptor path.
2. **Property channel soundness:** if a step emits `onModified(..., p, ...)`, then `p` must be declared mutable in descriptor metadata at the root-level contract currently used by the runtime.
3. **Shape soundness:** structural operations on arrays/objects in steps are reflected in descriptor structure.

This matches current runtime behavior, where mutable-property collection in `builder.ts` flattens mutable properties from the descriptor tree and registers listeners at emitted paths.

## Global Invariants

These invariants are the basis of all local proofs:

1. **Tree Well-Formedness**
   - Array names are interpreted as child edges.
   - Recursion terminates (finite tree).

2. **Collection-Key Referential Integrity**
   - Every name in `collectionKey` exists among node scalar names at that node.

3. **Path Closure**
   - Every path returned by `getPathSegmentsFromDescriptor` is realizable by descriptor traversal.

4. **Mutable Declaration Safety**
   - Any property newly produced via modification channels is included in `mutableProperties` at the effective descriptor contract used by runtime registration.

5. **Metadata Preservation Under Non-Shape Transforms**
   - Steps that do not intentionally alter metadata should preserve `mutableProperties` and `objects` definition status and values.

6. **Idempotent Descriptor Augmentation**
   - Re-applying the same descriptor augmentation step does not duplicate scalar/object/mutable entries.

## Step Transfer Functions

Let `F_step` denote descriptor transfer for a step.

### 1) InputPipeline

- `F_input` constructs a root node with:
  - `arrays = []`
  - `collectionKey = []`
  - `scalars = sourceScalars`

Proof role: base case for induction over step composition.

### 2) FilterStep

- `F_filter(D) = D` (descriptor identity).

Proof obligations:

- Event gating (predicate filtering) does not change structural type.
- Nested event suppression/replay preserves path validity because paths are delegated from input descriptor.

### 3) DefinePropertyStep

- Descriptor effect:
  - optionally adds `propertyName` to `mutableProperties` when the computed property depends on mutable inputs.
  - otherwise identity.

Proof obligations:

- If step emits `onModified` for computed property `p`, then `p` is in mutable metadata.
- Runtime add/remove payload enrichment does not require structural descriptor change.

Note: current implementation does not add the computed property to `scalars`; this implies scalar descriptors behave as a partial declaration set, not a complete one.

### 4) DropPropertyStep

Two modes:

- **Array drop:** remove target array edge at scoped path.
- **Scalar drop:** remove scalar name at scoped node; if dropped scalar is in `collectionKey`, current behavior clears `collectionKey` at that node; root metadata filters dropped name from `mutableProperties` and `objects` when those fields are defined.

Proof obligations:

- No emitted events reference removed array path.
- Dropped scalar no longer appears in node scalars.
- Metadata cleanup remains definition-preserving (defined optional fields stay defined, possibly empty).

### 5) GroupByStep

Descriptor effect:

- At grouping scope:
  - split source scalars into grouping-key scalars (parent node) and remainder (child node),
  - create/replace grouped parent array with grouped child array,
  - transform `collectionKey` by removing grouping keys from child and assigning grouping keys to group parent.
- Preserve root metadata intended for downstream mutable/object consumers.

Proof obligations:

- Path transformation bijection between old item paths and new grouped item paths.
- Key projection correctness (`collectionKey` at parent equals grouping properties).
- Metadata preservation is stable for both non-empty and empty-but-defined optional metadata fields.

### 6) CommutativeAggregateStep

Descriptor effect:

- add scalar output `propertyName` (idempotent),
- add mutable declaration for `propertyName` (idempotent).

Proof obligations:

- Aggregate property lives at parent path of aggregated array.
- Emitted modify events occur at that parent path only.
- Scalar + mutable declarations match emitted aggregate channel.

### 7) AverageAggregateStep

Descriptor effect: same class as commutative aggregate:

- add scalar `propertyName` idempotently,
- add mutable declaration idempotently.

Proof obligations are identical at descriptor level; runtime proof differs (sum/count state machine).

### 8) MinMaxAggregateStep

Descriptor effect: same as aggregate class:

- add scalar `propertyName` idempotently,
- add mutable declaration idempotently.

Descriptor-level obligations are the same parent-path aggregate obligations.

### 9) PickByMinMaxStep

Descriptor effect:

- adds object descriptor named `propertyName` whose type is the source array item descriptor,
- adds mutable declaration for `propertyName`.

Proof obligations:

- Object descriptor insertion occurs at parent path of selected array.
- Inserted object type is path-consistent with source array item type.
- Mutable declaration covers modify channel for picked object updates.

## Composition Theory

For a pipeline with steps `S1..Sn`, define:

- `D0 = F_input(source)`
- `Di = F_Si(Di-1)`
- `D* = Dn`

Main theorem skeleton:

1. **Local Soundness Theorem**
   For each step `Si`, if `Di-1` satisfies invariants, then `Di` satisfies invariants and `Si` runtime emissions are descriptor-sound with respect to `Di`.

2. **Compositional Soundness Corollary**
   By induction on `i`, `D*` is invariant-satisfying and the full pipeline emission behavior is descriptor-sound.

3. **Registration Completeness Lemma**
   Runtime listener registration driven by `getPathSegmentsFromDescriptor(D*)` and flattened mutable properties is sufficient to observe all descriptor-declared mutable channels.

## Proof Strategy

Recommended order:

1. Prove structural lemmas for path traversal and path extraction:
   - `getPathSegmentsFromDescriptor` path closure and completeness over descriptor arrays.
2. Prove metadata lemmas:
   - idempotence of scalar/mutable/object insertions,
   - preservation under identity and non-shape transforms.
3. Prove each step's local theorem.
4. Apply composition induction.

## Candidate Formalization

Any of the following can encode this model:

- Lean/Coq/Isabelle for machine-checked proofs,
- TLA+ for trace constraints and channel-soundness properties,
- executable TypeScript property tests as proof scaffolding before theorem proving.

Minimal formal core:

- inductive descriptor tree,
- path membership predicate,
- transfer functions as pure functions,
- step-specific emission predicates.

## Known Risk Areas To Address In Proofs

1. Optional metadata semantics (`undefined` vs explicitly empty list) must be explicit in the model.
2. Scalar descriptors are currently not a complete declaration of all emitted add/remove payload fields (for example, computed properties may be emitted without scalar insertion).
3. Root-level mutable-property flattening in runtime registration is a deliberate abstraction that should be represented as an implementation lemma, not assumed as a universal semantic truth.

## Next Document (Proof Plan)

A follow-up document should define:

- exact formal definitions (syntax and semantics),
- theorem statements with quantifiers,
- per-step proof scripts/obligations,
- executable property-test correspondences for each theorem.

