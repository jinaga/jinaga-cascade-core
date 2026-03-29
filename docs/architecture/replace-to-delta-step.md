# Replace-to-Delta Step (`replaceToDelta`)

## Goal

Define a pipeline step that transforms each event in a per-entity sub-array from absolute values to **delta** values relative to the event's predecessor within the same entity. The step enables downstream primitives (`flatten`, `groupBy`, `sum`, `cumulativeSum`) to compose a correct time-series aggregate without a fused monolithic step.

## Motivating Problem

When building a time series of totals under **replace semantics** (each entity's new event supersedes its previous one), the naive composition of "per-entity absolute values → groupBy time → sum → prefix sum" double-counts carried-forward contributions. The root cause is that absolute values at each event time include implicit history, and summing then prefix-summing cannot separate that history from the additive contribution.

By converting absolute values to deltas at the per-entity level, each event expresses only its **marginal change** relative to the predecessor. Downstream summation and prefix-summation then produce correct aggregates because deltas are additive by construction.

## Core Semantics

`replaceToDelta` is a **positional transform step** that operates on a doubly-nested structure: an entity collection containing event sub-arrays. For each event within an entity, it computes the difference between the event's property values and those of the entity's predecessor event (by `orderBy` order). Events with no predecessor use 0 as the baseline.

The step adds new delta properties to each event alongside the original properties. Original values are preserved — they may be needed by other downstream paths.

## Public API

```ts
replaceToDelta(
  entityArrayName: string,
  eventArrayName: string,
  orderBy: string[],
  properties: string[],
  outputProperties: string[]
)
```

Parameter roles:

- `entityArrayName` — the child array containing entities (e.g., `"attendees"`).
- `eventArrayName` — the sub-array within each entity containing time-ordered events (e.g., `"allocations"`).
- `orderBy` — one or more properties that define the chronological order within each entity. Lexicographic comparison. Must be a superset of the event sub-array's `collectionKey` (same validation as `timelineAggregate`).
- `properties` — the numeric properties on each event to compute deltas for (e.g., `["a0", "a1"]`).
- `outputProperties` — names for the delta properties added to each event (e.g., `["d0", "d1"]`). Must be the same length as `properties`.

Validation:

- `orderBy.length` must be at least 1.
- Every property in `orderBy` must be a scalar in the event type.
- `orderBy` must be a superset of the event sub-array's `collectionKey`.
- `properties.length` must equal `outputProperties.length`.
- Every property in `properties` must be a scalar in the event type.
- `entityArrayName` must reference a child array in the current scope.
- `eventArrayName` must reference a child array within the entity type.
- `outputProperties` must not collide with existing scalar names on the event type.

## Type Transformation

Input type (example):

```
{
  effectiveClass: string,
  attendees: KeyedArray<{
    attendeePublicKey: string,
    attendeeEventId: string,
    allocations: KeyedArray<{ createdAt: string, id: string, a0: number, a1: number }>
  }>
}
```

Output type:

```
{
  effectiveClass: string,
  attendees: KeyedArray<{
    attendeePublicKey: string,
    attendeeEventId: string,
    allocations: KeyedArray<{ createdAt: string, id: string, a0: number, a1: number, d0: number, d1: number }>
  }>
}
```

The structure is unchanged. Delta properties (`d0`, `d1`) are added as mutable scalars on the event type.

## TypeDescriptor Transformation

The step transforms the event sub-array's `DescriptorNode`:

1. Add each output property name to `scalars` (idempotent).
2. Add each output property name to `mutableProperties` (deltas change when predecessor events are added/removed).
3. Preserve all other fields at all levels (entity array, event array, parent-level scalars, arrays, objects, mutableProperties).

## Step Taxonomy Classification

| Category | What it does | Commutativity strategy | Example |
|----------|-------------|----------------------|---------|
| **Positional Transform** | Augments items based on position among siblings in a sorted collection | Sorted list → deterministic predecessor → deterministic delta | ReplaceToDeltaStep |

This is a new category. Unlike `DefinePropertyStep` (where the computed value depends only on the item's own properties), `replaceToDelta` computes values that depend on the item's **position** relative to siblings in a sorted order within the same parent entity.

## Internal State Model

Per entity (identified by entity key within parent context):

```
entityEvents: SortedList<Event>
```

Each entity's events, maintained in sort order by lexicographic comparison of the `orderBy` tuple. Supports O(log N) insert/remove and O(1) predecessor/successor lookup.

This is the only internal state. The delta values emitted for each event are derived on the fly from the sorted list's predecessor relationship. No per-event delta cache is stored — the delta is recomputed when needed (predecessor lookup is O(1), delta computation is O(properties.length)).

### Degrees of Freedom Check

- `entityEvents` captures each entity's independently varying event history (one structure per independent variable).
- Delta values are derived from the sorted list (not independently varying). No separate storage needed.

## Incremental Behavior

### Event added for entity E at time T with values V

1. Look up E's sorted event list. Find predecessor P before T (or none). Find successor S after T (or none).

2. Insert the event into E's sorted list. O(log N).

3. Compute the new event's delta: `delta[p] = V[p] - P[p]` for each property `p` (or `V[p] - 0` if no predecessor).

4. Emit `onAdded` for the new event, injecting the delta properties into the payload.

5. If successor S exists: S's delta changes from `S[p] - P[p]` to `S[p] - V[p]`. Compute old and new delta values. Emit `onModified` for each delta property on S where the value changed.

### Event removed for entity E at time T with values V

1. Find predecessor P before T (or none). Find successor S after T (or none).

2. Remove the event from E's sorted list.

3. If successor S exists: S's delta changes from `S[p] - V[p]` to `S[p] - P[p]`. Emit `onModified` for each delta property on S where the value changed.

4. Emit `onRemoved` for the event with its delta properties.

### Event property modified

If an aggregated property `p` on event E changes from `oldVal` to `newVal`:

1. Recompute E's delta: the delta changes by `newVal - oldVal`. Emit `onModified` for the corresponding output property.

2. If successor S exists: S's delta changes because its predecessor (E) changed. Compute old and new delta for S. Emit `onModified` for S's delta property.

### Entity added / removed

Process each event as an individual addition (chronological order) or removal (reverse chronological order), following the patterns above.

## Scope and Path Resolution

The step subscribes at two levels from its current scope:

| Path | Derivation | Purpose |
|------|-----------|---------|
| Entity path | `[...scopeSegments, entityArrayName]` | Track entity add/remove to manage per-entity state |
| Event path | `[...scopeSegments, entityArrayName, eventArrayName]` | Track event add/remove/modify for delta computation |

## Handler Forwarding

The step wraps `onAdded` and `onRemoved` at the event path to inject delta properties into the payload (following the DefinePropertyStep augmentation pattern). It captures `onModified` handlers for the delta property names at the event path. All other registrations forward to `this.input`.

## Commutativity Guarantee

**Claim**: For any two orderings of add/remove operations on the same multiset of entities and events, the `ReplaceToDeltaStep` produces the same delta values for each event.

**Proof**:

1. **Sorted event list is order-independent.** Each entity's sorted list is a deterministic function of the current set of events (a set is order-independent; the sorted list is a deterministic function of the set).

2. **Predecessor relationship is order-independent.** For any event E in the sorted list, the predecessor is the event with the greatest `orderBy` tuple strictly less than E's. This is a deterministic function of the sorted list.

3. **Delta is order-independent.** `delta[p] = E[p] - predecessor[p]` is a deterministic function of E and its predecessor.

4. **Therefore**: same event set → same sorted lists → same predecessors → same deltas, regardless of operation order. QED.

## Complexity Analysis

Let N = number of events in an entity's sorted list.

| Operation | Sorted insert/remove | Delta computation | Successor update | Total |
|-----------|---------------------|-------------------|-----------------|-------|
| Event add | O(log N) | O(1) | O(1) | O(log N) |
| Event remove | O(log N) | — | O(1) | O(log N) |
| Property modify | — | O(1) | O(1) | O(1) |

Each event operation affects at most two events' delta values (the event itself and its successor). This is O(1) downstream emissions per input event.

**Memory**: O(N) per entity for the sorted event list.

## Correctness Invariants

1. **Delta accuracy.** For every event E in entity, the emitted delta equals `E[p] - predecessor[p]` (or `E[p]` if no predecessor) computed from the current sorted list.
2. **Successor propagation.** When an event is added or removed, the successor event's delta is updated if it exists.
3. **Exact inverse.** Removing an event exactly undoes the effect of adding it: the event's delta is removed, and the successor's delta reverts.
4. **Modification minimality.** `onModified` is emitted only for delta properties whose values actually changed.

## Test Matrix

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Single entity, single event | Delta equals the event's values (no predecessor, baseline is 0) |
| 2 | Single entity, two events added in order | First delta is absolute values; second delta is difference from first |
| 3 | Single entity, two events added in reverse order | Same deltas as #2 after both are present |
| 4 | Insert event between two existing events | New event gets delta from predecessor; successor's delta changes |
| 5 | Remove middle event | Successor's delta changes to reflect new predecessor |
| 6 | Add then remove same event | Deltas revert to prior state exactly |
| 7 | Property modification on event | Event's delta and successor's delta update |
| 8 | Entity added with pre-existing events | All deltas computed correctly |
| 9 | Entity removed | All state cleaned up |
| 10 | Commutativity: same events, different add orders | Identical deltas |

## Related Architecture Documents

- `time-series-aggregate-projection.md` — the fused single-step design that this step helps decompose
- `flatten-step.md` — the next step in the decomposed pipeline
- `cumulative-sum-step.md` — the final step in the decomposed pipeline
