# User Story: Timeline Aggregate Pipeline Step

## Story

**As a** pipeline author building live dashboards on time-varying per-entity data  
**I want to** define a pipeline step that emits one aggregate row per distinct event time, where each row sums every entity’s latest values as of that time  
**So that** charts and downstream steps stay correct under replace semantics, incremental updates, out-of-order arrival, and changes to non-temporal grouping dimensions (for example current class)

## Description

Many dashboards need a time series of **totals** where each entity contributes its **current latest value** at each point on the timeline—not a sum of every historical event, and not a value only on that entity’s own event times. A new allocation replaces the previous one; the series at time T must reflect each attendee’s latest allocation with `createdAt ≤ T`, summed with everyone else’s latest-as-of-T values.

That rule is easy to break when separate steps first build per-entity timelines only at each entity’s event times and then sum or prefix across time buckets: the same entity’s contribution can be counted more than once across buckets. This story specifies a **single** pipeline step that fuses per-entity “latest as of” tracking with cross-entity summation so the output timeline is correct by construction.

The step consumes a two-level shape (a collection of entities, each with a time-ordered event sub-array) and produces a one-level timeline array on the parent context. Parent-level scalars are preserved; the entity collection is replaced by the timeline output. Non-temporal dimensions (for example effective class from enrichment) continue to be modeled with existing grouping and enrichment steps; when such a dimension changes, the entity moves between parent groups and the step removes contributions from the old group’s timeline and adds them to the new one, so historical time points stay consistent with the current grouping.

### Out of scope

- Replacing client-side full replay for every use case (acceptable for small data, but this story targets incremental reactive pipelines).
- A two-step composition of “per-entity latest timeline” plus “cumulative sum” without the fused semantics (known incorrect for replace semantics).

## Acceptance Criteria

### Core semantics and output shape

#### AC1: One row per global time key

**Given** a parent context with one or more entities, each with events ordered by a configured `orderBy` property array  
**When** the step runs  
**Then** the output timeline shall contain exactly one row per distinct composite time key occurring anywhere among those entities’ events in that parent context  
**And** each row shall expose the configured output property names for the summed “latest as of” values at that time key.

#### AC2: Replace semantics across entities (no double-counting)

**Given** two entities in the same parent context, with events such that one entity updates later while another event occurs at an intermediate time  
**When** aggregates are read at each time key in order  
**Then** at each key the total shall equal the sum over entities of that entity’s latest event values at or before that key  
**And** the result shall match the canonical example: after A at t1 with 10, B at t2 with 5, and A at t3 with 20 replacing earlier A, the series shall be t1 = 10, t2 = 15, t3 = 25 (not 35 at t3).

#### AC3: Incremental and order-independent convergence

**Given** the same multiset of entities and events  
**When** those events are applied in different orders (including out of chronological order)  
**Then** the final set of time keys and aggregate values shall be identical across orderings.

### Entity and event lifecycle

#### AC4: Entity added or removed

**Given** an entity with zero or more events in its sub-array  
**When** the entity is added to the collection  
**Then** its events shall be incorporated so the timeline matches the semantics in AC1–AC2.  

**Given** an entity present in the collection  
**When** the entity is removed  
**Then** all of that entity’s contributions shall be removed from the timeline and the remaining aggregates shall match AC2.

#### AC5: Event removed or modified

**Given** an existing event  
**When** the event is removed  
**Then** affected time keys shall update or disappear so invariants in the technical notes hold and totals match a from-scratch recomputation.  

**Given** an event whose aggregated numeric fields change  
**When** that change is propagated  
**Then** every affected time bucket’s aggregates shall change by the correct delta through the successor time range for that entity.

### Edge cases and ordering

#### AC6: Empty and zero contributions

**Given** no entities, or entities with no events  
**When** the step materializes the timeline  
**Then** the timeline shall be empty or shall omit contributions as appropriate so no spurious rows appear.  

**Given** a numeric property value of zero  
**When** that value is the latest as of some time key  
**Then** zero shall contribute to the sum like any other number. Missing or undefined values shall behave consistently with sum semantics for the platform (for example treated as zero where that is the established rule).

#### AC7: Lexicographic ordering and within-entity totality

**Given** an `orderBy` array with at least one property name  
**When** two events are compared for ordering  
**Then** the first property in `orderBy` shall be used as the primary ordering key  
**And** only when values are equal on that property shall comparison proceed to the next property, continuing lexicographically through the array until order is determined.

**Given** an `orderBy` array that is a superset of the event sub-array's `collectionKey`  
**When** two events belong to the same entity  
**Then** they shall always have distinct `orderBy` tuples (no within-entity collisions).

**Given** multiple events from different entities whose `orderBy` tuples are fully equal  
**When** those events map to the same time bucket  
**Then** the bucket's aggregate shall include all of their contributions.

#### AC9: Validation rejects `orderBy` that does not cover event `collectionKey`

**Given** an `orderBy` array that does not include every property from the event sub-array's `collectionKey`  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

### Integration with grouping dimensions

#### AC8: Entity moves between parent groups

**Given** a non-temporal grouping property (for example current class) derived upstream  
**When** that property changes so the entity leaves one parent group and enters another  
**Then** the old group’s timeline shall lose that entity’s contributions and the new group’s timeline shall gain them  
**And** both timelines shall remain consistent with AC2 for their respective entity sets.

## Technical Notes

- **Aggregate definition:** For each time key T (in sorted order among all keys in the parent context), each entity contributes the values from its most recent event with sort key ≤ T; entities with no such event contribute zero for each summed property.
- **Type shape:** Parent-level fields other than the configured entity collection remain; the entity collection is replaced by a timeline array whose `collectionKey` is the `orderBy` properties. Each timeline row carries the `orderBy` properties under their original names and types (copied from the event type) plus one scalar per summed output property. No synthetic key field is needed. Aggregate output properties on timeline rows are mutable because later events can change totals for earlier-looking buckets when replace semantics shift contributions; the `orderBy` properties are immutable (they are the row's identity).
- **Validation:** The number of input property names to sum must match the number of output property names; referenced arrays and scalar fields must exist on the corresponding types; `orderBy` must contain at least one property name; every `orderBy` property must be a scalar on the event type; `orderBy` must be a superset of the event sub-array's `collectionKey` (guarantees within-entity total ordering, checkable at build time from the type descriptor).
- **Performance intent:** Per update, work should scale with the number of time buckets affected by an entity’s successor interval, not require a full rescan of all entities for every change at trivial scales.

## Related Files

- `docs/architecture/time-series-aggregate-projection.md` — full semantics, internal model, test matrix, and API sketch for the timeline aggregate step

## Related User Stories

- None recorded in this repository yet; prerequisite capabilities include grouping entities under a parent context, enriching entities with current-state dimensions, and time-ordered event arrays per entity.

## Related User Journeys

- Not linked; add a journey reference when a pipeline-author journey document exists for building multi-step pipelines.
