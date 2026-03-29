# User Story: Flatten Pipeline Step

## Story

**As a** pipeline author building aggregates that cross entity boundaries  
**I want to** define a pipeline step that collapses a parent array and its child sub-array into a single flat collection  
**So that** downstream single-level primitives like `groupBy` and `sum` can operate across all child items regardless of which parent they belong to

## Description

Several pipeline patterns produce a two-level structure — for example, entities each containing a time-ordered event sub-array — where downstream steps need to treat the child items as one flat collection. Without a flatten step, the only way to aggregate across parent boundaries is a fused step that internally traverses both levels. `flatten` makes this cross-boundary operation explicit and composable: flatten first, then apply standard single-level primitives.

The step consumes a parent array and its child sub-array and produces a single output array at the same scope level. Each output item carries scalars from both its parent and its child, so entity-identifying properties remain available for downstream disambiguation or grouping. The output array replaces the parent array; scope-level properties above the parent array are preserved.

When parent and child scalars share a name, the child's value takes precedence — the child is the more specific level, analogous to SQL column resolution in a join.

### Out of scope

- Adding nesting levels (that is the responsibility of `groupBy`).
- Computing deltas or running totals (handled by `replaceToDelta` and `cumulativeSum`).
- Merging scalars from more than two levels in a single step (flatten one level at a time).

## Acceptance Criteria

### Core flattening behavior

#### AC1: One output item per parent-child pair

**Given** a parent array with one or more parents, each containing a child sub-array with one or more children  
**When** the step processes the input  
**Then** the output array shall contain exactly one item per (parent, child) pair  
**And** each output item shall carry all scalars from both the parent and the child.

#### AC2: Composite collection key preserves identity

**Given** a parent with collection key properties and a child with its own collection key properties  
**When** the output type is constructed  
**Then** the output collection key shall be the concatenation of the parent's key and the child's key  
**And** two children from different parents with the same child key shall have distinct composite keys in the output.

#### AC3: Scope-level properties preserved

**Given** scalar properties on the scope above the parent array  
**When** the step transforms the type  
**Then** those scope-level scalars shall be preserved unchanged in the output  
**And** only the parent array shall be replaced by the output array.

#### AC4: Child scalar takes precedence on name collision

**Given** a parent scalar and a child scalar with the same name  
**When** the step merges scalars into the output item  
**Then** the child's value shall take precedence over the parent's value.

### Incremental child and parent lifecycle

#### AC5: Child added to existing parent

**Given** a parent already present in the collection  
**When** a new child is added to that parent's sub-array  
**Then** a new flattened output item shall appear containing the parent's scalars merged with the child's scalars.

#### AC6: Child removed from parent

**Given** a flattened output item corresponding to a (parent, child) pair  
**When** the child is removed from its parent's sub-array  
**Then** the corresponding flattened output item shall be removed.

#### AC7: Parent removed removes all flattened children

**Given** a parent with multiple children  
**When** the parent is removed from the collection  
**Then** all of that parent's flattened output items shall be removed  
**And** no orphan items shall remain.

#### AC8: Parent with no children produces no output

**Given** a parent with an empty child sub-array  
**When** the step processes the input  
**Then** no flattened output items shall exist for that parent.

### Modification propagation

#### AC9: Parent scalar modification fans out to all children

**Given** a parent with multiple flattened children  
**When** a mutable scalar on the parent changes  
**Then** all of that parent's flattened output items shall receive a modification notification with the old and new values.

#### AC10: Child scalar modification affects only one output item

**Given** a flattened output item corresponding to a specific (parent, child) pair  
**When** a mutable scalar on the child changes  
**Then** only that single flattened item shall receive the modification  
**And** other items from the same parent shall be unaffected.

### Incremental and order-independent behavior

#### AC11: Commutativity across operation orderings

**Given** the same multiset of parents and children  
**When** those items are applied in different orders  
**Then** the final set of flattened output items and their scalar values shall be identical across orderings.

#### AC12: Add then remove reverts to prior state

**Given** a child added to a parent  
**When** that same child is subsequently removed  
**Then** the output shall be identical to the state before the child was added.

### Validation

#### AC13: Referenced arrays must exist

**Given** a `parentArrayName` that does not reference a child array in the current scope, or a `childArrayName` that does not reference a child array within the parent type  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

#### AC14: Output array name must not collide

**Given** an `outputArrayName` that collides with an existing array name at the current scope level  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

## Technical Notes

- **Composite key uniqueness:** The output collection key is `[...parentCollectionKey, ...childCollectionKey]`. The parent key uniquely identifies the parent; the child key uniquely identifies the child within a parent. Together they uniquely identify any (parent, child) pair in the flattened collection. Downstream steps can `groupBy` on child key properties to re-aggregate by time point while parent key properties remain available for disambiguation.
- **Parent scalar storage:** The step stores each parent's scalar values so they can be merged into child payloads when a child is added (the child `onAdded` payload contains only child scalars). Memory cost is O(P) where P is the number of parents.
- **Mutable property merging:** The output type's `mutableProperties` is the union of parent and child mutable properties, filtered to only include properties present in the merged scalar set.
- **Deeper arrays preserved:** If the child type has its own nested arrays (below the consumed child sub-array), those are preserved on the flattened output type.

## Related Files

- `docs/architecture/flatten-step.md` — full semantics, internal model, test matrix, and API specification

## Related User Stories

- **Replace-to-Delta Pipeline Step** — the predecessor step in the decomposed pipeline; produces per-entity deltas that `flatten` collapses into a single collection
- **Timeline Aggregate Pipeline Step** — the fused single-step design that this step (together with `replaceToDelta`, `groupBy`, `sum`, and `cumulativeSum`) decomposes into composable primitives

## Related User Journeys

- Not linked; add a journey reference when a pipeline-author journey document exists for building decomposed time-series aggregate pipelines.
