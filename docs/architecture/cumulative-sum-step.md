# Cumulative Sum Step (`cumulativeSum`)

## Goal

Define a pipeline step that transforms numeric properties on items in a sorted collection into their **prefix sums** (running totals) over the collection's sort order. This is a general-purpose primitive useful for any scenario where per-item values need to become cumulative totals.

## Motivating Problem

After the `replaceToDelta` → `flatten` → `groupBy` → `sum` pipeline, each time bucket holds the **per-bucket delta sum** — the total change in aggregate value at that time point. To produce the final time-series (where each bucket's value is the running total of all preceding deltas), a prefix sum over the sorted buckets is needed.

More generally, any sorted collection where items represent incremental contributions (counts, deltas, deposits) benefits from a cumulative transformation to produce running totals, balances, or cumulative distributions.

## Core Semantics

`cumulativeSum` is a **transform step** that operates on a sorted child array. For each item in the array (in sort order), it replaces specified property values with the sum of that property across all items at or before the current position.

Given items sorted by `orderBy` with values `v₁, v₂, v₃, ...`, the output values are `v₁, v₁+v₂, v₁+v₂+v₃, ...`.

The step does not change the collection's structure, keys, or item count. It transforms property values in place.

## Public API

```ts
cumulativeSum(
  arrayName: string,
  orderBy: string[],
  properties: string[]
)
```

Parameter roles:

- `arrayName` — the child array to operate on (e.g., `"byTime"`).
- `orderBy` — one or more properties that define the sort order for prefix summation (e.g., `["createdAt", "id"]`). Lexicographic comparison.
- `properties` — the numeric properties to transform into prefix sums (e.g., `["t0", "t1", "t2"]`). These must be mutable properties on the array's item type (since they already exist on input items and will be modified by this step).

Validation:

- `orderBy.length` must be at least 1.
- Every property in `orderBy` must be a scalar in the array's item type.
- Every property in `properties` must be a mutable scalar in the array's item type. (The input properties must already be mutable because the step reads them from `onAdded` payloads and listens for `onModified` on them. The step replaces their emitted values with cumulative versions.)
- `arrayName` must reference a child array in the current scope.

## Type Transformation

The step does not change the type. Input and output have the same scalars, collection key, arrays, and objects.

Input type (example):

```
{
  effectiveClass: string,
  byTime: KeyedArray<{ createdAt: string, id: string, t0: number, t1: number }>
}
```

Output type (identical structure, different runtime values):

```
{
  effectiveClass: string,
  byTime: KeyedArray<{ createdAt: string, id: string, t0: number, t1: number }>
}
```

The `t0` and `t1` values in the output are cumulative sums over the sorted order, not per-item values. The type descriptor does not distinguish between per-item and cumulative semantics — both are `number`.

## TypeDescriptor Transformation

Identity — `F_cumulativeSum(D) = D`. The step transforms values at runtime but does not alter the descriptor.

The transformed properties are already mutable on input (required by validation). They remain mutable on output (the cumulative values change when upstream items are added, removed, or modified).

## Step Taxonomy Classification

| Category | What it does | Commutativity strategy | Example |
|----------|-------------|----------------------|---------|
| **Positional Transform** | Transforms item values based on position in sorted collection | Sorted list → deterministic prefix sums | CumulativeSumStep |

Like `replaceToDelta`, this step's output depends on the item's position relative to its siblings, not just its own properties. Both are positional transforms; `replaceToDelta` computes differences from the predecessor, while `cumulativeSum` computes sums of all predecessors.

## Internal State Model

Per parent context (the scope above the target array):

```
sortedItems: SortedMap<OrderByTuple, ItemState>
```

Where `ItemState` holds:
- `inputValues: Record<string, number>` — the per-item values as received from upstream (before cumulative transformation)
- `cumulativeValues: Record<string, number>` — the prefix sum at this position

The `cumulativeValues` are derivable from `inputValues` and the sort order, but are stored to enable O(1) lookup per item when emitting. Without this cache, computing a single item's cumulative value would require scanning all predecessors.

### Degrees of Freedom Check

- `sortedItems` captures the independently varying set of items and their values.
- `cumulativeValues` is a derived cache. Stored to avoid O(N) recomputation per access. Acceptable under the rule that permits caches reducing time complexity.

## Incremental Behavior

### Item added at position K with input values V

1. Insert the item into the sorted map. O(log N).

2. Compute the new item's cumulative value: `cumulative[p] = predecessor_cumulative[p] + V[p]` for each property `p` (or `V[p]` if no predecessor).

3. Emit `onAdded` for the item with `cumulativeValues` in the payload (replacing the input values for the transformed properties).

4. For each subsequent item in sort order: update its cumulative value by adding `V[p]` to each property. Emit `onModified` with old and new cumulative values.

### Item removed at position K with input values V

1. For each subsequent item in sort order: update its cumulative value by subtracting `V[p]`. Emit `onModified` with old and new cumulative values.

2. Emit `onRemoved` for the item with its cumulative values.

3. Remove the item from the sorted map.

### Item property modified (upstream `onModified`)

If a cumulated property on the item at position K changes from `oldVal` to `newVal`:

1. Compute `delta = newVal - oldVal`.

2. Update the item's stored input value. Update its cumulative value by adding `delta`. Emit `onModified` with old and new cumulative values.

3. For each subsequent item in sort order: update cumulative value by adding `delta`. Emit `onModified`.

### Non-cumulated property modified

If an `orderBy` property changes, this constitutes a re-ordering. The step treats this as a remove at the old position followed by an add at the new position.

If a non-cumulated, non-orderBy property changes, the step forwards `onModified` without transformation.

## Scope and Path Resolution

| Path | Derivation | Purpose |
|------|-----------|---------|
| Array path | `[...scopeSegments, arrayName]` | Subscribe to item add/remove/modify |
| Output path | Same as array path | Emit transformed item events |

The step operates on an existing array without restructuring. The builder does not reset `scopeSegments`.

## Handler Forwarding

The step wraps `onAdded` at the array path to replace input property values with cumulative values in the payload. It intercepts `onModified` for the cumulated properties to emit cumulative-adjusted values. All other registrations forward to `this.input`.

For `onModified` on the cumulated properties, the step captures downstream handlers and emits cumulative old/new values (not the raw upstream old/new values). This breaks the simple forwarding pattern: the step must intercept, transform, and re-emit.

## Commutativity Guarantee

**Claim**: For any two orderings of add/remove operations on the same multiset of items, `CumulativeSumStep` produces the same cumulative values for each item.

**Proof**:

1. **Sorted item set is order-independent.** The sorted map is a deterministic function of the current item set.

2. **Prefix sum is order-independent.** For any item at position K in the sorted order, the cumulative value is `Σ inputValues[p] for items at positions 1..K`. This is a deterministic function of the sorted item set and the item's position.

3. **Therefore**: same item set → same sorted order → same prefix sums, regardless of operation order. QED.

## Complexity Analysis

Let N = number of items in the array.

| Operation | Sorted insert/remove | Suffix updates | Total |
|-----------|---------------------|----------------|-------|
| Item add | O(log N) | O(N - K) modifications | O(N) worst case |
| Item remove | O(log N) | O(N - K) modifications | O(N) worst case |
| Property modify | O(1) | O(N - K) modifications | O(N) worst case |

The worst case is O(N) when an item is added at or near the beginning of the sorted order, affecting all subsequent items. For the LaunchKings use case (N ~ 200 time buckets), this is acceptable. For larger data sets, this per-event cost should be documented.

**Memory**: O(N) for the sorted map with input and cumulative values.

### Amortized behavior

In typical time-series usage, new events are appended near the end of the sort order (recent timestamps). In this case, few or no subsequent items exist, and the suffix update cost approaches O(1). The O(N) worst case occurs only for out-of-order insertions at the beginning of the timeline.

## Correctness Invariants

1. **Prefix sum accuracy.** For every item at position K, `cumulativeValues[p] = Σ inputValues[p] for items at positions 1..K`.
2. **Input preservation.** The step stores input values separately and does not corrupt them. If the item is removed and re-added with the same values, the same cumulative result is produced.
3. **Suffix propagation.** When an item is added, removed, or modified, all subsequent items' cumulative values are updated.
4. **Exact inverse.** Removing an item exactly undoes the effect of adding it: the item's contribution is removed from all subsequent cumulative values.
5. **Modification minimality.** `onModified` is emitted only for items whose cumulative values actually changed. If `delta = 0`, no emissions occur.

## Test Matrix

### Core prefix sum behavior

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Single item | Cumulative value equals input value |
| 2 | Three items in sorted order | Values are v₁, v₁+v₂, v₁+v₂+v₃ |
| 3 | Items added in reverse order | Same cumulative values as #2 after all added |
| 4 | Item added in the middle | Inserted item and all successors update |
| 5 | Item removed from the middle | All successors' cumulative values decrease |
| 6 | Add then remove same item | Returns to prior state exactly |

### Property modification

| # | Scenario | Expected |
|---|----------|----------|
| 7 | Input value increases at position K | Item K and all successors increase by delta |
| 8 | Input value decreases to zero | Item K and all successors decrease; zero is a valid cumulative value |
| 9 | Input value change with delta = 0 | No `onModified` emissions |

### Commutativity and edge cases

| # | Scenario | Expected |
|---|----------|----------|
| 10 | Same items, different add orders | Identical cumulative values |
| 11 | Empty array | No output |
| 12 | All items removed | Empty output |
| 13 | Multiple properties cumulated simultaneously | Each property independently prefix-summed |

## Related Architecture Documents

- `replace-to-delta-step.md` — the step that produces deltas consumed (after flatten/groupBy/sum) by this step
- `flatten-step.md` — the structural step that precedes groupBy/sum in the decomposed pipeline
- `time-series-aggregate-projection.md` — the fused single-step design that this step helps decompose
