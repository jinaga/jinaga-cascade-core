# Flatten Step (`flatten`)

## Goal

Define a pipeline step that removes one level of array nesting by collapsing a parent array and its child sub-array into a single flat collection. Each flattened item carries properties from both the parent item and the child item.

This is the pipeline equivalent of SQL's implicit column inheritance in an inner join: for every (parent, child) pair, emit one row containing both levels' scalars.

## Motivating Problem

Several pipeline patterns produce a two-level structure (e.g., entities with event sub-arrays) where downstream steps need to operate on the child items as a single flat collection — for example, to `groupBy` a child-level property across all entities, or to aggregate child-level properties across parent boundaries.

Without `flatten`, the only way to cross parent boundaries is a fused step that internally traverses both levels. `flatten` makes this cross-boundary operation explicit and composable: flatten first, then apply standard single-level primitives.

## Core Semantics

`flatten` is a **structural step** that consumes a two-level structure (parent array → child sub-array) and produces a single-level array.

For a given scope:

- **Parent items** are items in the parent array. Each parent has scalars and a child sub-array.
- **Child items** are items in the child sub-array within each parent.
- **Output** is one item per (parent, child) pair. Each output item contains the parent's scalars and the child's scalars. On name collision, the child's scalar takes precedence (the child is the more specific level).

The output array replaces the parent array. Parent-level properties above the parent array are preserved.

## Public API

```ts
flatten(
  parentArrayName: string,
  childArrayName: string,
  outputArrayName: string
)
```

Parameter roles:

- `parentArrayName` — the array containing parent items (e.g., `"attendees"`).
- `childArrayName` — the sub-array within each parent containing child items (e.g., `"allocations"`).
- `outputArrayName` — the name for the flattened output array (e.g., `"allDeltas"`).

Validation:

- `parentArrayName` must reference a child array in the current scope.
- `childArrayName` must reference a child array within the parent item type.
- `outputArrayName` must not collide with existing array names at the current scope level.

## Type Transformation

Input type (example):

```
{
  effectiveClass: string,
  attendees: KeyedArray<{
    attendeePublicKey: string,
    attendeeEventId: string,
    allocations: KeyedArray<{ createdAt: string, id: string, d0: number, d1: number }>
  }>
}
```

Output type:

```
{
  effectiveClass: string,
  allDeltas: KeyedArray<{
    attendeePublicKey: string,
    attendeeEventId: string,
    createdAt: string,
    id: string,
    d0: number,
    d1: number
  }>
}
```

The parent array (`attendees`) is replaced by the flat output array (`allDeltas`). Each flattened item contains scalars from both the parent (entity key properties) and the child (event properties). Scope-level scalars above the parent array (`effectiveClass`) are preserved.

## TypeDescriptor Transformation

1. Remove the parent array descriptor (the array named `parentArrayName`).
2. Construct the flattened item type by merging parent and child `DescriptorNode`:
   - `collectionKey: [...parentCollectionKey, ...childCollectionKey]` — the composite key guarantees uniqueness across all (parent, child) pairs.
   - `scalars`: union of parent scalars (excluding the child array) and child scalars. On name collision, use the child's scalar descriptor.
   - `mutableProperties`: union of parent and child mutable properties (filtered to only include properties present in the merged scalars).
   - `arrays`: child item's arrays (the child sub-array itself is consumed; any deeper arrays on the child are preserved).
   - `objects`: union of parent and child objects.
3. Add a new array descriptor named `outputArrayName` with the merged type.
4. Preserve all other scope-level scalars, arrays, objects, and mutableProperties.

### Collection Key Composition

The output `collectionKey` is `[...parentCollectionKey, ...childCollectionKey]`. This guarantees uniqueness:

- `parentCollectionKey` uniquely identifies the parent item within the parent array.
- `childCollectionKey` uniquely identifies the child item within a single parent.
- Together, they uniquely identify any (parent, child) pair in the flattened collection.

This composite key also preserves the identity chain: downstream steps can `groupBy` on child key properties to re-aggregate by time point, while the parent key properties remain available for disambiguation.

## Step Taxonomy Classification

| Category | What it does | Commutativity strategy | Example |
|----------|-------------|----------------------|---------|
| **Structural** | Collapses two nesting levels into one flat array | Deterministic merge of (parent, child) pairs | FlattenStep |

Most similar to `GroupByStep` (structural reshaping), but in the opposite direction: `groupBy` adds a nesting level; `flatten` removes one.

## Internal State Model

Per parent context (the scope above the parent array):

```
parentItems: Map<parentKey, { scalars: Record<string, unknown>, childKeys: Set<string> }>
```

Tracks each parent's scalar values and the set of child keys currently present. Needed to:
- Provide parent scalars when a child is added (the child `onAdded` payload only contains child scalars).
- Detect which children to remove when a parent is removed.
- Propagate parent-level `onModified` to all of the parent's flattened children.

### Degrees of Freedom Check

- `parentItems` represents the independently varying set of parents and their children (structural variable).
- No derived state is stored — flattened items are emitted on the fly by merging parent and child scalars.

## Incremental Behavior

### Child added for parent P

1. Look up P's stored scalars.
2. Merge P's scalars with the child's scalars.
3. Compute the composite key from P's key and the child's key.
4. Emit `onAdded` for the flattened item with the merged payload.

### Child removed from parent P

1. Compute the composite key.
2. Emit `onRemoved` for the flattened item with the merged payload.

### Parent added (with existing children)

1. Store P's scalars and initialize an empty child set.
2. For each child in P's sub-array (delivered via child-level `onAdded`): process as "child added for parent P."

### Parent removed (with all children)

1. For each child in P's sub-array (delivered via child-level `onRemoved`): process as "child removed from parent P."
2. Remove P from the parent map.

### Parent scalar modified

If a mutable scalar on parent P changes:

1. For each of P's flattened children: emit `onModified` for the changed property with old and new values.
2. Update P's stored scalars.

### Child scalar modified

If a mutable scalar on a child of parent P changes:

1. Emit `onModified` for the corresponding flattened item with old and new values. No fan-out — only the single affected item changes.

## Scope and Path Resolution

The step subscribes at two levels from its current scope:

| Path | Derivation | Purpose |
|------|-----------|---------|
| Parent path | `[...scopeSegments, parentArrayName]` | Track parent add/remove/modify |
| Child path | `[...scopeSegments, parentArrayName, childArrayName]` | Track child add/remove/modify |
| Output path | `[...scopeSegments, outputArrayName]` | Emit flattened item events; intercept handler registrations |

The builder resets `scopeSegments` to `[]` after `flatten` (standard for steps that restructure output).

## Handler Forwarding

The step intercepts registrations for:

- `onAdded`/`onRemoved`/`onModified` at the output path → captures handlers for flattened item events.
- Registrations for deeper paths below the output → maps to the corresponding child-level sub-paths and forwards to `this.input`, rewriting key paths to include the parent key segment.
- All other registrations → forwards to `this.input`.

## Commutativity Guarantee

**Claim**: For any two orderings of parent and child add/remove operations on the same multiset, `FlattenStep` produces the same set of flattened items.

**Proof**:

1. **Flattened item set is a cross-product.** The set of flattened items is `{(P, C) | P ∈ parents, C ∈ P.children}`. A set is order-independent.

2. **Each flattened item's properties are deterministic.** For a given (P, C) pair, the merged scalars are a deterministic function of P's scalars and C's scalars.

3. **Therefore**: same parent/child sets → same flattened items, regardless of operation order. QED.

## Complexity Analysis

| Operation | State update | Emissions | Total |
|-----------|-------------|-----------|-------|
| Child add | O(1) | O(1) — one `onAdded` | O(1) |
| Child remove | O(1) | O(1) — one `onRemoved` | O(1) |
| Parent add (M children) | O(M) | O(M) — one `onAdded` per child | O(M) |
| Parent remove (M children) | O(M) | O(M) — one `onRemoved` per child | O(M) |
| Parent scalar modify | O(1) | O(C) — one `onModified` per child of the modified parent | O(C) |
| Child scalar modify | O(1) | O(1) — one `onModified` | O(1) |

**Memory**: O(P) for parent scalar storage, where P is the number of parent items. Child scalars are not stored — they flow through from the input.

## Correctness Invariants

1. **Completeness.** For every (parent, child) pair in the input, exactly one flattened item exists in the output.
2. **No orphans.** Flattened items exist only while both their parent and child exist in the input.
3. **Property accuracy.** Each flattened item's scalars equal the merge of its parent's and child's current scalars.
4. **Modification propagation.** Parent-level scalar changes propagate to all of the parent's flattened children. Child-level changes propagate to exactly one flattened item.
5. **Exact inverse.** Removing a child (or parent) exactly undoes the corresponding additions.

## Test Matrix

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Single parent, single child | One flattened item with merged scalars |
| 2 | Single parent, multiple children | One flattened item per child, all sharing parent scalars |
| 3 | Multiple parents, non-overlapping children | Flattened items partitioned by parent key |
| 4 | Child added to existing parent | New flattened item appears |
| 5 | Child removed from parent | Flattened item disappears |
| 6 | Parent removed | All of parent's flattened children disappear |
| 7 | Parent scalar modified | All of parent's flattened children emit `onModified` |
| 8 | Child scalar modified | Only the affected flattened item emits `onModified` |
| 9 | Add then remove same child | Returns to prior state exactly |
| 10 | Different operation orders | Same final flattened set (commutativity) |
| 11 | Empty parent (no children) | No flattened items for that parent |
| 12 | Scalar name collision between parent and child | Child's value takes precedence |
| 13 | Composite collection key uniqueness | Two children from different parents with same child key have distinct composite keys |

## Related Architecture Documents

- `replace-to-delta-step.md` — the predecessor step in the decomposed pipeline
- `cumulative-sum-step.md` — the final step in the decomposed pipeline
- `time-series-aggregate-projection.md` — the fused single-step design that this step helps decompose
