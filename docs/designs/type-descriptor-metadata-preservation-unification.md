# Type Descriptor Metadata Preservation Unification

## Purpose

Design a unified, correctness-first approach for descriptor metadata propagation so `mutableProperties` and `objects` remain semantically consistent across all step transforms, including nested scopes.

This design addresses the observed issues in:

- `src/steps/group-by.ts` (metadata dropped in nested transforms and empty-list erasure),
- `src/steps/drop-property.ts` (root-only metadata filtering for scoped scalar drops),
- all related descriptor-writing code paths that currently reimplement partial cloning logic.

## Degrees of Freedom Check

1. **Independently varying domain variable**: descriptor metadata state per node (`mutableProperties`, `objects`) including definition status and contents.
2. **Why this cannot be fixed policy**: metadata differs by node and by transform scope; a single global policy cannot represent scoped changes correctly.
3. **What is simplified**: replace ad hoc per-step cloning/filtering with shared descriptor transform primitives and uniform semantics.

## Problem Summary

Current code has three classes of inconsistency:

1. **Definition-status erasure (`[]` -> `undefined`)**
   - Example: `group-by` only copies `objects` when `length > 0`.
   - Result: explicitly empty metadata is lost.

2. **Nested metadata loss during structural transforms**
   - Example: `group-by` nested transform rebuilds nodes with only `collectionKey/scalars/arrays`, dropping optional metadata on traversed nodes.

3. **Root-only metadata cleanup for scoped drops**
   - Example: scalar drop filters `objects` only on the root descriptor, leaving stale nested object descriptors when property is dropped in nested scope.

These violations make descriptor state non-compositional and block strong correctness proofs.

## Design Principles

1. **Node-local metadata semantics**
   - `mutableProperties` and `objects` are properties of each `DescriptorNode`, not just root.

2. **Definition-status preservation by default**
   - If a metadata field is defined on input node, transformed node keeps it defined unless intentionally removed.
   - Preserve distinction:
     - `undefined`: not declared/unspecified
     - `[]`: explicitly declared empty

3. **Scope-local edits**
   - Property drop at scope `S` only edits node `S` metadata unless behavior explicitly requires broader cleanup.

4. **Correctness over compatibility**
   - Prefer semantically precise metadata even if this surfaces differences in descriptors previously hidden by root-only behavior.

## Unified Semantics

### Metadata Fields

For any node `N`:

- `N.mutableProperties` and `N.objects` are optional finite lists.
- Transformations must obey:
  - **Preserve rule**: if untouched, preserve value and definedness.
  - **Edit rule**: if edited, preserve definedness (`undefined` remains undefined unless transform intentionally introduces field).
  - **Introduce rule**: steps that produce new mutable/object properties can introduce metadata explicitly.

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
- Guarantees optional metadata preserved unless override provided.

### 2) `mapNodeAtArrayPath`

- Input: root node, array-segment path, mapper.
- Applies mapper exactly at target node; preserves all untouched nodes via spread.
- Eliminates custom recursive clone variants across steps.

### 3) `filterNodeMetadataByProperty`

- Input: node, property name.
- Removes property from `mutableProperties` and `objects` on that node only.
- Preserves definedness (defined list can become `[]`, not `undefined`).

### 4) `copyOptionalList`

- Utility for optional list fields:
  - `undefined -> undefined`
  - defined list -> shallow copy (including empty list)

## Step-Level Changes (Design)

### `GroupByStep`

1. **Root and nested branches**
   - Replace `length > 0` checks with definition checks for `objects`.
   - Use `copyOptionalList` semantics.

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
- Ensure object insertion and mutable insertion remain idempotent and preserve optional field semantics.

### Aggregate and define-property steps

- Continue root-level mutable insertion as current model requires, but apply via shared helper to enforce idempotence and optional-field handling.

## Cross-Cutting Invariants to Enforce

1. **No accidental metadata drops**
   - Any node not intentionally rewritten preserves metadata exactly.

2. **No `[]`/`undefined` conflation**
   - Optional-list definition status stable under pass-through transforms.

3. **Scoped cleanup correctness**
   - Dropped property metadata removed at exact target scope node.

4. **Idempotent insertions**
   - Repeated getTypeDescriptor calls do not duplicate metadata entries.

## Test Strategy

Add/expand tests in descriptor-focused suites:

1. **GroupBy metadata preservation**
   - Nested scope (`scopeSegments.length > 1`) with metadata on intermediate nodes.
   - Assert intermediate `objects`/`mutableProperties` survive regrouping.

2. **Empty-list preservation**
   - Input with `objects: []` stays defined after `groupBy` root and nested variants.

3. **Scoped drop of nested objects**
   - Build nested object descriptor via `pickByMax`/`pickByMin` with multi-segment path.
   - Drop at that nested scope.
   - Assert nested `objects` no longer contains dropped name.
   - Assert root/unrelated scopes unchanged.

4. **Regression matrix across steps**
   - Compose `pickBy* -> groupBy -> dropProperty` and `groupBy -> pickBy* -> dropProperty`.
   - Validate descriptor invariants and runtime output shape alignment.

5. **Property-based descriptor invariants (optional)**
   - For random descriptor trees, verify helper transforms preserve untouched-node metadata.

## Migration Plan

1. Add shared transform helpers with unit tests.
2. Refactor `group-by` to helper-based cloning and metadata copy semantics.
3. Refactor `drop-property` scalar path cleanup to scoped metadata edit.
4. Refactor `pick-by-min-max` and aggregate/define-property descriptor writes to shared helpers.
5. Add regression tests, then remove obsolete ad hoc logic.

## Risks and Mitigations

1. **Risk: behavior change in descriptor snapshots**
   - Mitigation: codify new semantics in tests and docs; this is correctness-improving.

2. **Risk: ambiguity about parent vs child metadata during groupBy split**
   - Mitigation: document explicit assignment policy and test both channels.

3. **Risk: hidden dependencies on root-only metadata**
   - Mitigation: keep root metadata behavior while adding nested correctness; validate runtime registration still passes.

## Acceptance Criteria

Design is complete when implementation can satisfy:

1. No step drops optional metadata on untouched nodes.
2. `objects: []` and `mutableProperties: []` remain defined when intentionally defined.
3. Nested-scope scalar drop removes same-scope object metadata entries.
4. All descriptor-writing steps use shared helper primitives.
5. Composition tests demonstrate stable descriptor semantics across mixed step pipelines.

## Relationship to Proof Foundation

This design operationalizes invariants and obligations from `docs/architecture/type-descriptor-correctness-foundation.md`, especially:

- metadata preservation under non-shape transforms,
- scoped correctness of metadata edits,
- idempotent descriptor augmentation.

It is the implementation blueprint needed before mechanizing full proofs.

