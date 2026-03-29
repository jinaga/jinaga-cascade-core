# User Story: Replace-to-Delta Pipeline Step

## Story

**As a** pipeline author composing time-series aggregates from per-entity event streams under replace semantics  
**I want to** define a pipeline step that converts each event's absolute property values into deltas relative to the entity's preceding event  
**So that** downstream summation and prefix-sum steps produce correct totals without double-counting carried-forward contributions

## Description

When entities emit events under replace semantics (each new event supersedes the previous one), the absolute values on each event implicitly include historical state. If those absolute values are summed directly across time buckets and then prefix-summed, the result double-counts contributions that carry forward from earlier events.

The `replaceToDelta` step solves this by computing, for each event within an entity's time-ordered sub-array, the difference between that event's numeric properties and those of its predecessor. The first event in an entity (no predecessor) uses a baseline of zero, so its delta equals its absolute value. After this transform, every event expresses only its **marginal change**, and downstream steps (`flatten`, `groupBy`, `sum`, `cumulativeSum`) compose correctly because deltas are additive by construction.

The step operates on a doubly-nested structure — an entity collection where each entity contains a time-ordered event sub-array — and adds new delta properties to each event alongside the originals. The original properties are preserved because other downstream paths may still need them.

### Out of scope

- Changing the collection structure or removing nesting levels (that is the responsibility of `flatten`).
- Producing cumulative or running totals (that is the responsibility of `cumulativeSum`).
- Handling non-temporal grouping dimensions (handled by upstream enrichment and grouping steps).

## Acceptance Criteria

### Core delta computation

#### AC1: Delta from predecessor within the same entity

**Given** a parent context with one or more entities, each with events sorted by the configured `orderBy` properties  
**When** the step processes an event that has a predecessor within the same entity  
**Then** the output delta properties shall equal the event's property values minus the predecessor's property values  
**And** the original property values shall be preserved unchanged on the event.

#### AC2: First event uses zero baseline

**Given** an entity with a single event (no predecessor)  
**When** the step processes that event  
**Then** the delta properties shall equal the event's absolute property values (baseline of zero).

#### AC3: Insertion between existing events updates successor

**Given** an entity with events at times T1 and T3  
**When** a new event is inserted at time T2 (between T1 and T3)  
**Then** the new event's delta shall be computed relative to the T1 event  
**And** the T3 event's delta shall be recomputed relative to the T2 event instead of T1.

### Incremental and order-independent behavior

#### AC4: Commutativity across operation orderings

**Given** the same multiset of entities and events  
**When** those events are applied in different orders (including out of chronological order)  
**Then** the final delta values for each event shall be identical across orderings.

#### AC5: Event removal reverts deltas

**Given** an entity with events at times T1, T2, and T3  
**When** the T2 event is removed  
**Then** the T3 event's delta shall be recomputed relative to T1  
**And** the resulting deltas shall be identical to a state where T2 was never added.

#### AC6: Property modification propagates

**Given** an event whose aggregated numeric property changes from an old value to a new value  
**When** that modification is propagated  
**Then** the event's own delta shall update to reflect the changed value  
**And** the successor event's delta (if one exists) shall also update because its predecessor's value changed.

### Entity lifecycle

#### AC7: Entity added with events

**Given** a new entity added to the collection with pre-existing events in its sub-array  
**When** the step processes the entity  
**Then** all of the entity's events shall receive correct delta values as though the events were added one at a time in chronological order.

#### AC8: Entity removed

**Given** an entity present in the collection  
**When** the entity is removed  
**Then** all per-entity state for that entity shall be cleaned up  
**And** delta removals shall be emitted for each of the entity's events.

### Validation

#### AC9: Matching property and output property counts

**Given** `properties` and `outputProperties` arrays of different lengths  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

#### AC10: OrderBy covers event collection key

**Given** an `orderBy` array that does not include every property from the event sub-array's `collectionKey`  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

#### AC11: Output property name collision

**Given** an `outputProperties` entry that collides with an existing scalar name on the event type  
**When** the pipeline is constructed  
**Then** the step shall reject the configuration with a validation error.

## Technical Notes

- **Sorted event list per entity:** Each entity maintains its events in a sorted list ordered by lexicographic comparison of the `orderBy` tuple. This supports O(log N) insert/remove and O(1) predecessor/successor lookup.
- **Delta derivation:** Delta values are not stored separately — they are derived on the fly from the predecessor relationship in the sorted list. Per-event delta computation is O(1) given O(1) predecessor lookup.
- **Successor propagation:** Adding or removing an event affects at most two events' deltas: the event itself and its immediate successor. This bounds downstream emissions to O(1) per input event operation (excluding the O(log N) sorted insertion).
- **Type transformation:** The step adds each output property as a mutable scalar on the event sub-array's type descriptor. Delta values are mutable because they change whenever predecessor events are added or removed. All other type structure (entity array, parent scalars, event key properties) is preserved.

## Related Files

- `docs/architecture/replace-to-delta-step.md` — full semantics, internal model, test matrix, and API specification

## Related User Stories

- **Timeline Aggregate Pipeline Step** — the fused single-step design that this step (together with `flatten`, `groupBy`, `sum`, and `cumulativeSum`) decomposes into composable primitives

## Related User Journeys

- Not linked; add a journey reference when a pipeline-author journey document exists for building decomposed time-series aggregate pipelines.

