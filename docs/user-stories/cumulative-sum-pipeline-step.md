# User Story: Cumulative Sum Pipeline Step

## Story

**As a** pipeline author producing running totals from incremental per-bucket values  
**I want to** define a pipeline step that transforms numeric properties on items in a sorted collection into their prefix sums  
**So that** each item's output value reflects the cumulative total of all items at or before its position, turning per-bucket deltas into a complete time series

## Description

After a pipeline converts per-entity absolute values to deltas (`replaceToDelta`), flattens across entity boundaries (`flatten`), groups by time key (`groupBy`), and sums within each bucket (`sum`), each time bucket holds the total **change** at that point — not the running total. To produce the final time series where each bucket's value represents the aggregate total through that point, a prefix sum over the sorted buckets is needed.

The `cumulativeSum` step is a general-purpose primitive: given items `v₁, v₂, v₃, …` sorted by `orderBy`, it produces `v₁, v₁+v₂, v₁+v₂+v₃, …`. This applies to any sorted collection where items represent incremental contributions (counts, deltas, deposits) and the desired output is running totals, balances, or cumulative distributions.

The step does not change the collection's structure, keys, or item count. It transforms property values in place — the same properties that held per-item input values now hold cumulative values in the output. The type descriptor is unchanged because the step modifies runtime values, not the shape.

### Out of scope

- Computing deltas from absolute values (handled by `replaceToDelta`).
- Flattening nested structures (handled by `flatten`).
- Grouping or summing items (handled by `groupBy` and `sum`).
- Changing collection structure or adding/removing items.

## Acceptance Criteria

### Core prefix sum behavior

#### AC1: Single item equals its own value

**Given** a sorted collection with one item  
**When** the step processes the collection  
**Then** the cumulative value shall equal the item's input value.

#### AC2: Prefix sums across multiple items

**Given** a sorted collection with items having input values v₁, v₂, v₃ in sort order  
**When** the step processes the collection  
**Then** the output values shall be v₁, v₁+v₂, v₁+v₂+v₃ respectively.

#### AC3: Multiple properties cumulated independently

**Given** a step configured with multiple numeric properties  
**When** the step processes the collection  
**Then** each property shall be independently prefix-summed over the sort order.

### Incremental item lifecycle

#### AC4: Item added updates all successors

**Given** an existing sorted collection  
**When** a new item is inserted at position K  
**Then** the new item's cumulative value shall equal its predecessor's cumulative value plus its own input value (or its own input value if no predecessor)  
**And** every item after position K shall have its cumulative value increased by the new item's input value.

#### AC5: Item removed updates all successors

**Given** a sorted collection with an item at position K  
**When** that item is removed  
**Then** every item after position K shall have its cumulative value decreased by the removed item's input value.

#### AC6: Add then remove reverts to prior state

**Given** an item added to the collection  
**When** that same item is subsequently removed  
**Then** all cumulative values shall be identical to the state before the item was added.

### Property modification

#### AC7: Input value change propagates through suffix

**Given** an item at position K whose input value changes by a delta  
**When** that modification is propagated  
**Then** the item's own cumulative value shall change by that delta  
**And** every subsequent item's cumulative value shall also change by that delta.

#### AC8: Zero-delta modification produces no emissions

**Given** an item whose input value is modified but the effective delta is zero  
**When** that modification is propagated  
**Then** no modification notifications shall be emitted for the item or its successors.

#### AC9: Non-cumulated property forwarded without transformation

**Given** a property that is not in the configured `properties` list and is not an `orderBy` property  
**When** that property is modified on an item  
**Then** the modification shall be forwarded downstream without transformation.

### Incremental and order-independent behavior

#### AC10: Commutativity across operation orderings

**Given** the same multiset of items  
**When** those items are applied in different orders (including reverse chronological order)  
**Then** the final cumulative values for each item shall be identical across orderings.

#### AC11: Empty collection produces no output

**Given** an empty collection (no items)  
**When** the step processes the collection  
**Then** the output shall be empty with no spurious items or values.

### Validation

#### AC12: Properties must be mutable scalars

**Given** a `properties` entry that references a non-mutable or non-existent scalar on the array's item type  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

#### AC13: OrderBy must reference existing scalars

**Given** an `orderBy` entry that does not reference a scalar in the array's item type  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

#### AC14: Array must exist in current scope

**Given** an `arrayName` that does not reference a child array in the current scope  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

## Technical Notes

- **Sorted map with cached cumulative values:** The step maintains a sorted map of items keyed by their `orderBy` tuple. Each entry stores the item's input values (as received from upstream) and its cumulative values (the prefix sum at that position). The cumulative values are a derived cache stored to avoid O(N) recomputation per access — without the cache, computing a single item's cumulative value would require scanning all predecessors.
- **Suffix update cost:** Adding or removing an item at position K requires updating cumulative values for all items after K. Worst case is O(N) when an item is inserted at the beginning. In typical time-series usage, new events append near the end (recent timestamps), so the suffix update cost approaches O(1).
- **Identity type transformation:** The step does not alter the type descriptor. Transformed properties are already mutable on input (required by validation) and remain mutable on output. The step transforms values at runtime only.
- **OrderBy property change as re-ordering:** If an `orderBy` property changes, the step treats this as a remove at the old position followed by an add at the new position.

## Related Files

- `docs/architecture/cumulative-sum-step.md` — full semantics, internal model, test matrix, and API specification

## Related User Stories

- **Replace-to-Delta Pipeline Step** — produces per-entity deltas that (after flatten/groupBy/sum) feed into this step's prefix summation
- **Flatten Pipeline Step** — the structural step that precedes groupBy/sum in the decomposed pipeline, collapsing entity-level nesting so deltas can be grouped by time
- **Timeline Aggregate Pipeline Step** — the fused single-step design that this step (together with `replaceToDelta`, `flatten`, `groupBy`, and `sum`) decomposes into composable primitives

## Related User Journeys

- Not linked; add a journey reference when a pipeline-author journey document exists for building decomposed time-series aggregate pipelines.
