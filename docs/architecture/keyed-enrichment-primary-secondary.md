# Keyed Enrichment (`enrich`) Architecture

## Goal

Define a single enrichment primitive, `enrich`, that augments each row from a **primary** pipeline with data from a **secondary** keyed source, incrementally and deterministically.

The output row set is always the primary row set.

## Core Semantics

`enrich` is **primary-driven**:

- Primary rows are the rows that flow through and remain in output.
- Secondary rows provide contextual data attached to each primary row.
- If no secondary match exists, the primary row still flows.
- `whenMissing` provides default enrichment when there is no match.

This is not a relational join family (`inner`, `right`, `full`). It is one directional primitive for business enrichment.

## Degrees of Freedom Check

1. **Independently varying domain variables**
   - The primary row set and its lifecycle.
   - The optional secondary match per join key (0 or 1).
2. **Why this cannot be a fixed policy**
   - Missing enrichment defaults vary by domain.
3. **What complexity is removed/simplified**
   - Replaces app-side enrichment caches with one pipeline primitive.
   - Uses the existing event model (`onAdded`, `onRemoved`, `onModified`).

## Public API

```ts
enrich<
  TSourceName extends string,
  TSecondary extends object,
  TSecondaryStart extends object,
  TSecondarySources extends Record<string, unknown>,
  TAs extends string
>(
  sourceName: TSourceName,
  secondaryPipeline: PipelineBuilder<TSecondary, TSecondaryStart, [], string, TSecondarySources>,
  primaryKey: (keyof NavigateToPath<T, Path> & string)[],
  as: TAs,
  whenMissing?: TSecondary
): PipelineBuilder<
  ...adds `TAs: TSecondary` at current path...,
  TStart,
  Path,
  RootScopeName,
  TSources & Record<TSourceName, { primary: TSecondaryStart; sources: TSecondarySources }>
>
```

Type parameter roles:

- `TSecondary` — inferred secondary output type; used directly for `whenMissing` and the `as` property type (no `PipelineOutput<>` indirection).
- `TSecondaryStart` — inferred secondary input type; becomes `primary` in the accumulated source spec.
- `TSecondarySources` — inferred from the secondary builder; enables recursive source wiring when the secondary pipeline itself uses `enrich`.
- `Path` is constrained to `[]` on the secondary builder, enforcing that the secondary pipeline is root-scope (where `collectionKey` is meaningful).

Decisions:

- Primitive name is `enrich`.
- No aliases (`leftJoin`, `lookup`) are exposed.
- `sourceName` names the key under `pipeline.sources` at runtime.
- `secondaryPipeline` is the `PipelineBuilder` that defines the secondary row shape and `collectionKey`.
- `primaryKey` selects properties from the current scope; secondary key is implicit (always secondary `collectionKey`).
- `whenMissing` is typed as `TSecondary` directly — the full secondary pipeline output type.
- The current scope is known to the builder (`scopeSegments` / `RootScopeName`); the caller does not redundantly name it.
- The return type's `TSources` is an intersection, accumulating each `enrich` call's source spec. Recursive sources from the secondary builder are preserved via `TSecondarySources`.

## Key Matching and Order Alignment

When keys have multiple properties:

- Primary order is the order of `primaryKey` provided to `enrich(...)`.
- Secondary order is the order of the secondary `collectionKey`.
- In this system, collection key order is defined by the pipeline step that sets it, primarily `groupBy`, which preserves the caller-provided grouping property order.
- Alignment is positional.
- `primaryKey[i]` is compared to `secondaryCollectionKey[i]`.
- Key arrays must have equal length.

Validation:

- Each key member must be a scalar property in its descriptor.
- `primaryKey.length` must equal `secondaryCollectionKey.length`.
- Key arity mismatch is invalid and drops the operation with diagnostics.

Materialization:

- Build comparable key tuples from aligned values.
- Hash/compare tuples by position, not by original property names.
- This allows matching even when property names differ across primary and secondary.

## Secondary Key Constraint

The secondary join key is not configurable:

- Enrich always uses the full secondary `collectionKey`.
- This guarantees at most one secondary row per join key.
- Resolver policies are not part of the API.

Implications:

- Enrichment is a strict keyed lookup (0-or-1 secondary match per key).
- Runtime state and diagnostics are simpler (no duplicate selection logic).

## Runtime Source Binding

Secondary sources are structural inputs of the pipeline, not runtime options.

`PipelineInput` gains a `TSources` parameter for recursive source typing:

```ts
interface PipelineInput<TPrimary, TSources extends Record<string, unknown> = {}> {
  add(key: string, immutableProps: TPrimary): void;
  remove(key: string, immutableProps: TPrimary): void;

  sources: {
    [K in keyof TSources]:
      TSources[K] extends { primary: infer TSourcePrimary; sources?: infer TSourceChildren }
        ? PipelineInput<
            TSourcePrimary & object,
            TSourceChildren extends Record<string, unknown> ? TSourceChildren : {}
          >
        : never;
  };
}
```

`Pipeline` extends `PipelineInput`, adding runtime lifecycle methods:

```ts
interface Pipeline<TStart, TSources extends Record<string, unknown> = {}>
  extends PipelineInput<TStart, TSources> {
  flush(): void;
  dispose(options?: PipelineRuntimeDisposeOptions): void;
  isDisposed(): boolean;
}
```

`build()` returns `Pipeline<TStart, TSources>`. The caller uses the same object for primary input, source input, and lifecycle control.

Behavior:

- `pipeline.add/remove` target the primary input.
- `pipeline.sources.<sourceName>.add/remove` target secondary input.
- Source names and types are defined by `enrich(..., sourceName, secondaryPipeline, ...)` calls in the pipeline builder chain.
- Each `enrich` call accumulates its `sourceName` and secondary input type into the builder's `TSources`.
- Secondary pipelines can also call `enrich`, so source graphs are recursive.
- `flush()` and `dispose()` live on the root `Pipeline` only; source inputs do not independently flush or dispose.
- Runtime options remain focused on execution concerns (batching, flushing, diagnostics), not schema/source definition.

### Source Routing

`InputPipeline` grows source-routing capability. Each `enrich` call in the builder chain registers a named source with the `InputPipeline`. At `build()` time, the runtime session constructs `PipelineInput` facade objects for each registered source name. These facades delegate `add`/`remove` to the corresponding `EnrichStep`'s secondary input. Nested sources (from secondary pipelines that themselves call `enrich`) are wired recursively.

## `TSources` Type Parameter

`PipelineBuilder` gains a fifth type parameter:

```ts
PipelineBuilder<T, TStart, Path, RootScopeName, TSources>
```

`TSources` defaults to `{}` and is only populated by `enrich` calls. All existing builder methods (`defineProperty`, `groupBy`, `filter`, `sum`, `count`, `min`, `max`, `average`, `pickByMin`, `pickByMax`, `in`) pass `TSources` through unchanged. Application code that does not use `enrich` is unaffected: the parameter is inferred, never written by the caller, and `{}` produces `Pipeline<TStart>` with no `sources` property visible at the type level.

## Runtime Step Design

Implement `src/steps/enrich.ts` as `EnrichStep`.

`EnrichStep`:

- subscribes to primary row add/remove at enrichment scope,
- subscribes to secondary source add/remove and `onModified` events,
- maintains keyed indexes for incremental recomputation,
- emits:
  - enriched primary `onAdded` and `onRemoved`,
  - `onModified` on property `as` when the matched secondary value changes.

### State Model

- `primaryRowsById: Map<primaryId, PrimaryRecord>`
- `primaryIdsByJoinKey: Map<joinKeyHash, Set<primaryId>>`
- `secondaryRowByJoinKey: Map<joinKeyHash, SecondaryRecord>`

These are the minimal structures needed for locality and correctness.

The enrichment value for any primary row is always derivable at O(1): extract its join key from `primaryRowsById`, look up `secondaryRowByJoinKey[joinKey]`, fall back to `whenMissing` if absent. No per-primary-row cache is needed because invariant #3 (single-match determinism) guarantees all primary rows sharing a join key share the same enrichment value.

### Incremental Behavior

**Primary add**

1. Index primary row by computed join key.
2. Resolve matched secondary value for that key (or `whenMissing`).
3. Emit enriched add.

**Primary remove**

1. Derive current enrichment value from `secondaryRowByJoinKey` (or `whenMissing`).
2. Emit enriched remove.
3. Remove all primary tracking state.

**Secondary add/remove**

1. Read current enrichment value from `secondaryRowByJoinKey` (or `whenMissing`) before mutating.
2. Update secondary record for affected key.
3. Derive new enrichment value.
4. If old ≠ new, emit `onModified(as)` to impacted primary rows for that key only.

**Secondary onModified**

1. Look up the secondary record in `secondaryRowByJoinKey` by the event's key.
2. Save the current record as old enrichment value.
3. Apply the property change to the stored secondary record.
4. If old ≠ new enrichment value, emit `onModified(as)` to impacted primary rows for that key only.

This handles mutable properties on the secondary pipeline (e.g., from `defineProperty` or aggregates) without requiring the caller to model changes as remove+add.

## TypeDescriptor Transformation

`EnrichStep` transforms the type descriptor following the same pattern as `PickByMinMaxStep`:

- Add an `ObjectDescriptor` with `name: as` and `type:` set to the secondary pipeline's root `DescriptorNode` (scalars, arrays, collectionKey, objects, mutableProperties).
- Add `as` to the parent's `mutableProperties` (via `appendMutableIfMissing`), since the enrichment value can change when the secondary source changes.

The enrichment value is the full secondary pipeline output object, including its collection key fields. This means:

- The type of the `as` property is `PipelineOutput<TSecondaryBuilder>`.
- Its descriptor mirrors the secondary pipeline's root structure.
- No projection or flattening is applied; the secondary shape is embedded as-is.

## Correctness Invariants

1. **Primary flow**
   - Every primary add/remove yields exactly one enriched add/remove.
2. **Join-key locality**
   - A secondary event affects only primary rows at the same computed key.
3. **Single-match determinism**
   - For fixed key and secondary state, the enrichment value is uniquely determined.
4. **Modification minimality**
   - Emit `onModified(as)` only when selected enrichment changes.
5. **Index integrity**
   - Index membership reflects canonical primary/secondary row stores.

## Performance

Let:

- `Pk` = primary rows for key `k`

Then:

- Primary add/remove: `O(1)` index work + `O(1)` lookup.
- Secondary add/remove: `O(1)` secondary map update + `O(Pk)` fan-out.

Memory is linear in active primary rows, secondary rows, and index entries.

## Diagnostics

Add diagnostics for:

- `unknown_secondary_source_dropped`
- `enrich_key_arity_mismatch`
- `enrich_invalid_primary_key_property`
- `enrich_secondary_collection_key_missing`

## Example: Orders Enriched with Customer Status

Primary rows are orders:

- `orderId` is unique order identity.
- `customerId` is not unique (many orders per customer).

Secondary rows are customer status records:

- `customerId` is the secondary collection key (unique).

```ts
// CustomerStatus = { customerId: string, status: string }
// Order = { orderId: string, customerId: string, total: number }

// Secondary pipeline: groups by customerId, establishing collectionKey as ["customerId"].
// Output type: { customerId: string, customerStatuses: KeyedArray<{ status: string }> }
const customerStatusPipeline = createPipeline<CustomerStatus>("customerStatuses")
  .groupBy(["customerId"], "customerStatuses");

// Primary pipeline: enriches each order with the full secondary output object.
const ordersPipeline = createPipeline<Order>("orders")
  .enrich(
    "customerStatuses",       // sourceName: key in pipeline.sources
    customerStatusPipeline,   // secondaryPipeline: defines shape + collectionKey
    ["customerId"],           // primaryKey: aligned to secondary collectionKey
    "customerStatus",         // as: enrichment property name
    {                         // whenMissing: must match full secondary output type
      customerId: "",
      customerStatuses: []
    }
  );

// build() returns Pipeline<Order, { customerStatuses: { primary: CustomerStatus } }>
const pipeline = ordersPipeline.build(setState);

// Primary stream
pipeline.add("order-1", { orderId: "order-1", customerId: "c-1", total: 125 });

// Secondary stream (typed as CustomerStatus input from customerStatusPipeline)
pipeline.sources.customerStatuses.add("c-1", { customerId: "c-1", status: "gold" });
```

Result:

- Every order remains in output.
- Each order carries a `customerStatus` property holding the full secondary output object.
- When matched, `customerStatus` is `{ customerId: "c-1", customerStatuses: [{ key: "...", value: { status: "gold" } }] }`.
- When no match exists, `customerStatus` is the `whenMissing` default.
- Secondary changes (add, remove, or mutable property modification) update only orders for that customer ID.

## Testing Plan

Unit tests:

- primary rows flow with and without matches,
- key arity and scalar validation,
- implicit secondary-key behavior (`secondary.collectionKey` only),
- incremental recomputation only for affected join keys.

Integration tests:

- orders + customer status scenario end-to-end,
- mixed primary/secondary operation ordering with batch flush,
- downstream aggregate correctness under secondary churn.
