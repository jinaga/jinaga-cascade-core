# Type Descriptor Metadata Preservation Unification

## Purpose

Design a unified, correctness-first approach for descriptor metadata propagation so `mutableProperties` and `objects` remain semantically consistent across all step transforms, including nested scopes.

This design addresses the observed issues in:

- `src/steps/group-by.ts` (metadata dropped in nested transforms and empty-list erasure),
- `src/steps/drop-property.ts` (root-only metadata filtering for scoped scalar drops),
- all related descriptor-writing code paths that currently reimplement partial cloning logic.

## Degrees of Freedom Check

1. **Independently varying domain variable**: descriptor metadata contents per node (`mutableProperties`, `objects`), not metadata "definedness".
2. **Why this cannot be fixed policy**: metadata differs by node and by transform scope; a single global policy cannot represent scoped changes correctly.
3. **What is simplified**: eliminate dual representations (`undefined` vs `[]`) and replace ad hoc per-step cloning/filtering with shared descriptor transform primitives and uniform semantics.

## Problem Summary

Current code has three classes of inconsistency:

1. **Dual representation of "no metadata"**
   - Current model allows both `undefined` and `[]` to mean "none".
   - Result: transforms can accidentally change meaning or shape (`[]` -> `undefined`) and create non-compositional behavior.

2. **Nested metadata loss during structural transforms**
   - Example: `group-by` nested transform rebuilds nodes with only `collectionKey/scalars/arrays`, dropping optional metadata on traversed nodes.

3. **Root-only metadata cleanup for scoped drops**
   - Example: scalar drop filters `objects` only on the root descriptor, leaving stale nested object descriptors when property is dropped in nested scope.

These violations make descriptor state non-compositional and block strong correctness proofs.

## Design Principles

1. **Node-local metadata semantics**
   - `mutableProperties` and `objects` are properties of each `DescriptorNode`, not just root.

2. **Canonical representation**
   - `mutableProperties` and `objects` are always present arrays on every node.
   - `[]` is the only representation of "none".
   - `undefined` is forbidden in normalized descriptors.

3. **Scope-local edits**
   - Property drop at scope `S` only edits node `S` metadata unless behavior explicitly requires broader cleanup.

4. **Correctness over compatibility**
   - Prefer semantically precise metadata even if this surfaces differences in descriptors previously hidden by root-only behavior.

## Unified Semantics

### Metadata Fields

For any node `N`:

- `N.mutableProperties` and `N.objects` are required finite lists (possibly empty).
- Transformations must obey:
  - **Preserve rule**: if untouched, preserve list contents exactly.
  - **Edit rule**: edits produce lists (possibly empty), never `undefined`.
  - **Introduce rule**: steps that produce new mutable/object properties append idempotently.

### Type-Level Canonicalization

Descriptor types should be changed to make illegal states unrepresentable:

- In `DescriptorNode`, replace:
  - `objects?: ObjectDescriptor[]`
  - `mutableProperties?: string[]`
- With:
  - `objects: ObjectDescriptor[]`
  - `mutableProperties: string[]`

This is an intentional correctness-first breaking change.

Normalization boundary:

- `createPipeline` / descriptor constructors must initialize both lists to `[]`.
- Any legacy descriptor sources (if any) are normalized at ingress:
  - `objects ?? []`
  - `mutableProperties ?? []`
- After ingress normalization, the rest of the codebase treats both fields as total.

### Drop Semantics

For scalar property drop `dropProperty(p)` at scope node `S`:

- Remove `p` from `S.scalars`.
- Update `S.collectionKey` according to current policy.
- Remove `p` from `S.mutableProperties` if defined.
- Remove object descriptor named `p` from `S.objects` if defined.
- Do not remove `p` metadata at unrelated nodes.

### Grouping Semantics

For `groupBy` at scope node `S`:

- Structural rewrite at `S` is intentional.
- For all ancestors and unaffected siblings traversed to reach `S`, preserve all metadata fields.
- For newly constructed nodes at grouped boundary:
  - preserve metadata where semantically corresponding,
  - ensure child item node keeps original item metadata unless explicitly transformed.

## Shared Descriptor Transform API

Create `src/util/descriptor-transform.ts` with pure helpers.

### 1) `cloneNodePreservingMetadata`

- Input: `DescriptorNode`, plus overrides for structural fields.
- Behavior: copies node via spread and applies overrides.
- Guarantees metadata lists are preserved unless override provided.

### 2) `mapNodeAtArrayPath`

- Input: root node, array-segment path, mapper.
- Applies mapper exactly at target node; preserves all untouched nodes via spread.
- Eliminates custom recursive clone variants across steps.

### 3) `filterNodeMetadataByProperty`

- Input: node, property name.
- Removes property from `mutableProperties` and `objects` on that node only.
- Output fields remain total arrays.

### 4) `normalizeNodeMetadata`

- Utility used only at boundaries (construction/legacy ingress):
  - `objects = objects ?? []`
  - `mutableProperties = mutableProperties ?? []`
- Never needed inside normalized transforms.

## Step-Level Changes (Design)

### `GroupByStep`

1. **Root and nested branches**
   - Remove `length > 0` and `undefined` checks for metadata fields.
   - Use direct array copies when needed.

2. **`transformDescriptorAtPathWithParentName`**
   - Preserve metadata on all recursively rebuilt nodes with spread-based cloning.
   - At grouped-node construction, explicitly define what metadata belongs to:
     - parent group node,
     - child item node.
   - Default policy: child node retains original item metadata; parent node only receives metadata that semantically applies to grouped parent.

### `DropPropertyStep`

1. **Scalar path transform**
   - Move metadata filtering into scoped transform (`transformDescriptorForScalarDrop`) at terminal scope node.
   - Remove root-only object filtering from `finalizeScalarDropDescriptor`.

2. **Finalize function**
   - Reduce to root wrapper concerns (for example `rootCollectionName`) only.

### `PickByMinMaxStep` and related writers

- Keep behavior but migrate descriptor mutations to shared helpers.
- Ensure object insertion and mutable insertion remain idempotent with total-array semantics.

### Aggregate and define-property steps

- Continue root-level mutable insertion as current model requires, but apply via shared helper to enforce idempotence and optional-field handling.
- Continue root-level mutable insertion as current model requires, but apply via shared helper to enforce idempotence and total-array semantics.

## Cross-Cutting Invariants to Enforce

1. **No accidental metadata drops**
   - Any node not intentionally rewritten preserves metadata exactly.

2. **Canonical metadata totality**
   - `objects` and `mutableProperties` are arrays at every node in every descriptor.

3. **Scoped cleanup correctness**
   - Dropped property metadata removed at exact target scope node.

4. **Idempotent insertions**
   - Repeated getTypeDescriptor calls do not duplicate metadata entries.

## Test Strategy

Add/expand tests in descriptor-focused suites:

1. **GroupBy metadata preservation**
   - Nested scope (`scopeSegments.length > 1`) with metadata on intermediate nodes.
   - Assert intermediate `objects`/`mutableProperties` survive regrouping.

2. **Canonical-shape preservation**
   - All transformed descriptors keep `objects`/`mutableProperties` present as arrays at all nodes.

3. **Scoped drop of nested objects**
   - Build nested object descriptor via `pickByMax`/`pickByMin` with multi-segment path.
   - Drop at that nested scope.
   - Assert nested `objects` no longer contains dropped name.
   - Assert root/unrelated scopes unchanged.

4. **Regression matrix across steps**
   - Compose `pickBy* -> groupBy -> dropProperty` and `groupBy -> pickBy* -> dropProperty`.
   - Validate descriptor invariants and runtime output shape alignment.

5. **Property-based descriptor invariants (optional)**
   - For random descriptor trees, verify helper transforms preserve untouched-node metadata and never produce `undefined` metadata lists.

## Migration Plan

1. Update descriptor types in `src/pipeline.ts` to make metadata lists required.
2. Add normalization at descriptor construction/ingress boundaries.
3. Add shared transform helpers with unit tests (operating on total metadata lists).
4. Refactor `group-by` to helper-based cloning and metadata-preserving semantics.
5. Refactor `drop-property` scalar path cleanup to scoped metadata edit.
6. Refactor `pick-by-min-max` and aggregate/define-property descriptor writes to shared helpers.
7. Add regression tests, then remove obsolete ad hoc logic and optional-field branches.

## Risks and Mitigations

1. **Risk: behavior change in descriptor snapshots and typings**
   - Mitigation: codify new semantics in tests and docs; this is correctness-improving.

2. **Risk: ambiguity about parent vs child metadata during groupBy split**
   - Mitigation: document explicit assignment policy and test both channels.

3. **Risk: hidden dependencies on optional metadata checks**
   - Mitigation: remove optional checks systematically; compile-time type errors guide full migration; validate runtime registration still passes.

## Acceptance Criteria

Design is complete when implementation can satisfy:

1. No step drops metadata on untouched nodes.
2. `DescriptorNode.objects` and `DescriptorNode.mutableProperties` are non-optional everywhere.
3. No descriptor emitted by `getTypeDescriptor()` contains `undefined` metadata lists.
4. Nested-scope scalar drop removes same-scope object metadata entries.
5. All descriptor-writing steps use shared helper primitives.
6. Composition tests demonstrate stable descriptor semantics across mixed step pipelines.

## Relationship to Proof Foundation

This design operationalizes invariants and obligations from `docs/architecture/type-descriptor-correctness-foundation.md`, especially:

- metadata preservation under non-shape transforms,
- scoped correctness of metadata edits,
- idempotent descriptor augmentation.

It is the implementation blueprint needed before mechanizing full proofs.

