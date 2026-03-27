# Identity Derived from Properties

## Goal

Unify how item identity (keys) are produced across the pipeline by deriving keys from immutable properties at every level, eliminating the caller-supplied key parameter from the public interface.

This document defines:

- the current inconsistency between root-level and internal key production,
- the target model where identity is a function of declared properties,
- the public interface changes required,
- the internal invariants that hold before and after the change,
- migration impact on existing call sites.

## Scope

Affected surface:

- `PipelineInput<T>` and `Pipeline<TStart>` in `src/pipeline.ts`
- `InputPipeline` in `src/factory.ts`
- `createPipeline` factory overloads in `src/factory.ts`
- `PipelineRuntimeSessionImpl.add` and `.remove` in `src/builder.ts`
- `PipelineSources` type and enrichment source inputs in `src/pipeline.ts`
- `run-pipeline.ts` key-generation boilerplate
- all test call sites that pass keys to `add` and `remove`

Unaffected surface (keys remain internal):

- `AddedHandler`, `RemovedHandler`, `ModifiedHandler` signatures
- `GroupByStep` key derivation via `computeGroupKey`
- `EnrichStep` primary/secondary join key tracking
- `addToKeyedArray`, `removeFromKeyedArray`, `modifyInKeyedArray` in `builder.ts` and `enrich.ts`
- `KeyedArray<T>` output representation

## Current State: Two Key-Production Models

### Root level — caller-supplied

The caller passes an opaque string key alongside the data:

```typescript
pipeline.add("order-1", { orderId: "order-1", customerId: "c-1", total: 125 });
```

`InputPipeline` forwards this key verbatim to handlers. The `TypeDescriptor` at the root has `collectionKey: []`, declaring no identity properties.

### Internal levels — derived from properties

`GroupByStep` computes group keys from grouping property values via `computeGroupKey`, a SHA-512 hash of the canonicalized property subset. The caller never sees these keys. The `TypeDescriptor` at group level has `collectionKey` set to the grouping property names.

This asymmetry means:

1. Root-level callers must invent or compute keys — duplicating information already present in the data.
2. The root `TypeDescriptor` has an empty `collectionKey`, which downstream steps (e.g., enrichment) cannot use to infer join semantics.
3. `run-pipeline.ts` contains boilerplate that hashes all properties to produce a key before calling `add`.

## Target Model: Identity as a Property Function

### Principle

All properties of the pipeline input type are immutable and collectively form the item's identity. The key is derived internally as `computeGroupKey(immutableProps, collectionKeyNames)` where `collectionKeyNames` is the full set of property names declared at creation time.

This mirrors the pattern already used by `GroupByStep` and makes root-level key production consistent with every other level in the pipeline.

### Descriptor Initialization

`InputPipeline.getTypeDescriptor()` changes from:

```
arrays = []
collectionKey = []
scalars = sourceScalars
objects = []
mutableProperties = []
```

to:

```
arrays = []
collectionKey = sourceScalars.map(s => s.name)
scalars = sourceScalars
objects = []
mutableProperties = []
```

The `collectionKey` is no longer empty at the root. It is the full set of scalar names, because all properties are part of the identity.

## Public Interface Changes

### 1. `createPipeline` — schema becomes required

Current overloads:

```typescript
function createPipeline<TStart extends object>(): PipelineBuilder<...>;
function createPipeline<TStart extends object, TRootScopeName extends string>(
    rootScopeName: TRootScopeName,
    sourceScalars?: ScalarDescriptor[]
): PipelineBuilder<...>;
```

Target: the zero-argument overload is removed. The scalar schema is required because TypeScript erases type parameters at runtime; the pipeline needs runtime property metadata to derive keys and populate the descriptor.

```typescript
function createPipeline<TStart extends object, TRootScopeName extends string>(
    rootScopeName: TRootScopeName,
    sourceScalars: ScalarDescriptor[]
): PipelineBuilder<...>;
```

Every property of `TStart` must appear in `sourceScalars`. The pipeline uses these names both as `scalars` and as `collectionKey` in the root `TypeDescriptor`.

### 2. `PipelineInput<T>` — drop the key parameter

Current:

```typescript
interface PipelineInput<T, TSources> {
    add(key: string, immutableProps: T): void;
    remove(key: string, immutableProps: T): void;
    sources: PipelineSources<TSources>;
}
```

Target:

```typescript
interface PipelineInput<T, TSources> {
    add(immutableProps: T): void;
    remove(immutableProps: T): void;
    sources: PipelineSources<TSources>;
}
```

### 3. `Pipeline<TStart>` — inherits the change

`Pipeline` extends `PipelineInput`, so the signature change propagates automatically. `flush`, `dispose`, and `isDisposed` are unaffected.

### 4. `InputPipeline` — derives key internally

`InputPipeline.add` and `.remove` compute the key from properties before forwarding to handlers:

```
add(immutableProps: T):
    key = computeGroupKey(immutableProps, collectionKeyNames)
    for each handler: handler([], key, immutableProps)

remove(immutableProps: T):
    key = computeGroupKey(immutableProps, collectionKeyNames)
    for each handler: handler([], key, immutableProps)
```

where `collectionKeyNames = sourceScalars.map(s => s.name)`.

### 5. `PipelineRuntimeSessionImpl` — same signature change

The session's `add` and `remove` methods delegate to `InputPipeline`, so they adopt the same `(immutableProps: T)` signature. Epoch checks and diagnostic reporting continue to work; the `key` field in diagnostics becomes the derived key.

## Invariants

### Preserved invariants

These hold before and after the change:

1. **Key uniqueness per collection.** Items with distinct property values produce distinct keys (guaranteed by the hash function over distinct canonical serializations).
2. **Add/remove symmetry.** Calling `remove` with the same property values as `add` produces the same derived key, so the item is correctly identified for removal.
3. **Internal handler contract.** `AddedHandler(keyPath, key, immutableProps)` continues to receive a string key. The change is invisible to all internal steps.
4. **KeyedArray output structure.** Output items retain `{ key, value }` shape. The key is now a content-derived hash rather than a caller-chosen string.

### New invariant

5. **Root collectionKey completeness.** The root `TypeDescriptor.collectionKey` contains all scalar names, matching the set used for key derivation. This enables downstream steps to inspect root identity properties — for example, enrichment could validate that a primary key reference exists in the root's `collectionKey`.

### Invariant from the type descriptor correctness foundation

Global Invariant 2 (Collection-Key Referential Integrity) requires every name in `collectionKey` to exist among node scalar names. This is satisfied by construction: `collectionKey` is derived from `sourceScalars.map(s => s.name)`, which is the same set as `scalars`.

## Redundancy Elimination

The current interface has a degree-of-freedom problem. Consider the test:

```typescript
pipeline.add("order-1", { orderId: "order-1", customerId: "c-1", total: 125 });
```

The key `"order-1"` is either:

- **Redundant with the data** — the identity is already captured by `orderId`. Two storage locations represent one domain variable.
- **Independent of the data** — the key carries information that no property captures. But then `remove` requires the caller to remember an arbitrary string unrelated to the data, which is error-prone.

In practice, every observed usage falls into the first case. The `run-pipeline.ts` runner makes this explicit by computing the key from properties before calling `add`. Removing the parameter eliminates the redundant degree of freedom.

## Migration Impact

### Test call sites

Every `pipeline.add(key, props)` becomes `pipeline.add(props)`. Every `pipeline.remove(key, props)` becomes `pipeline.remove(props)`. The key argument is deleted at each call site.

Every `createPipeline<T>()` (zero-argument form) gains a required scalars array. Every `createPipeline<T>(name)` that omits scalars gains a required scalars array.

### Source inputs (enrichment)

Enrichment source pipelines accessed via `pipeline.sources.X.add(key, props)` follow the same change. The source `PipelineInput` also derives keys from properties.

### run-pipeline.ts

The `computeGroupKey(itemObj, Object.keys(itemObj))` boilerplate before calling `add` is eliminated. The runner calls `add(item)` directly.

### Output consumers

No change. `KeyedArray<T>` and `toPipelinePlainOutput` are unaffected. The keys in the output become content-derived hashes instead of caller-chosen strings, but consumers that inspect keys (tests checking `{ key: 'status-1', value: ... }` in enrichment output) will need to compare against the derived hash or ignore the key field.

## Type-Safety Opportunity

The current `ScalarDescriptor` is `{ name: string; type: ScalarType }`. The `name` field is an unchecked string with no compile-time relationship to `TStart`. A typed schema could enforce correspondence:

```typescript
type ScalarSchema<T> = { [K in keyof T]: ScalarType };
```

This would cause a compile error if the schema omits a property or includes a property not in `T`. Whether to adopt this depends on whether the additional type machinery is worth the ergonomic benefit. The architecture works with either representation; the typed form adds a compile-time safety net over the runtime-only contract.

## Relationship to Existing Architecture

### Type Descriptor Correctness Foundation

The change strengthens the base case of the composition theory. Currently `F_input` produces `collectionKey = []`, which means Global Invariant 2 (Collection-Key Referential Integrity) is vacuously satisfied at the root. After the change, the root has a non-trivial `collectionKey` that is referentially sound by construction.

### Keyed Enrichment

Enrichment's `primaryJoinFromPrimaryRow` inspects property values to compute join keys. With a populated root `collectionKey`, the enrichment step could validate at construction time that the declared primary key properties are a subset of the root's identity properties — currently impossible because `collectionKey` is empty.

### GroupByStep

`GroupByStep` already derives keys from `collectionKey` properties and splits scalars between parent and child. The root now follows the same pattern, making the key-derivation model uniform from input through every transformation.
