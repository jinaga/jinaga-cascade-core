# Time-Series Aggregate Projection (`timelineAggregate`)

## Goal

Define a single pipeline step that computes a time-series of aggregate values across a collection of entities, where each entity contributes its "latest value as of" each time point.

The step produces one output row per distinct event timestamp, where each row contains the aggregate (sum) of all entities' latest values at that moment in time.

## Motivating Problem

In LaunchKings, attendees cast vote allocations during live events. An admin dashboard must display a time-series chart of total allocations per finalist, grouped by attendee class.

The business rule:

> For any timestamp T and class C:
> `Total(C, T) = Σ over attendees with currentClass=C of (attendee's latest allocation as of T)`

Key characteristics:

- **Replace semantics.** Each attendee's new allocation supersedes their previous one. The "latest as of T" for an attendee is the allocation with the greatest `createdAt ≤ T`.
- **Retroactive class assignment.** If an attendee's class changes, it affects all data points retroactively. Class is a current-state dimension, not a temporal one.
- **Incremental updates.** Allocations arrive continuously. The chart must update without full recomputation.
- **Order-independent convergence.** Allocations may arrive out of order. The final time series must be identical regardless of arrival order.

## Why Existing Primitives Cannot Express This

- `pickByMax` collapses to a single winner per entity, discarding the history needed for a time series.
- `commutativeAggregate` maintains a single scalar per parent, not per-time-bucket values.
- `groupBy` on `createdAt` creates per-timestamp buckets, but each bucket contains only events recorded at exactly that time, not the cumulative "latest per entity" state.

## Why a Two-Primitive Composition Fails

A natural decomposition is:

1. **Per-entity timeline step**: for each entity, emit one row per event time with the entity's latest value at that time.
2. **Cross-entity cumulative sum**: sum across entities per time bucket, then compute prefix sums.

This fails due to double-counting under replace semantics. Demonstration with a concrete example:

**Setup**: Two attendees (A and B), both general class.

- t1: A allocates a0=10
- t2: B allocates a0=5
- t3: A re-allocates a0=20

**Expected time series**: t1=10, t2=15, t3=25 (at t3, A's latest is 20, B's is 5).

**What the two-primitive composition produces**:

1. Per-entity timeline (each entity's own event times only):
   - A: `[{t1, a0=10}, {t3, a0=20}]`
   - B: `[{t2, a0=5}]`

2. GroupBy `(class, timeKey)` then sum across entities:
   - (general, t1): sum = 10
   - (general, t2): sum = 5
   - (general, t3): sum = 20

3. Cumulative sum (prefix sums):
   - t1: 10
   - t2: 15
   - **t3: 35** ← WRONG, expected 25

The cumulative sum adds A's t1 contribution (10) alongside A's t3 replacement (20), double-counting A. The replace semantics is lost because the per-entity step only emits rows at the entity's own event times. At time t2, attendee A has no timeline row, so A's carried-forward value of 10 is invisible. The cumulative sum then incorrectly treats per-bucket sums as additive deltas.

**Root cause**: the per-entity step operates within a single entity group and has no visibility into the global set of time points. The cross-entity aggregation and per-entity timeline tracking are coupled — separating them requires either (a) emitting deltas rather than absolute values, tightly coupling the two steps, or (b) emitting rows at all global time points per entity, requiring cross-entity awareness that breaks per-entity scoping.

The corrected design fuses these concerns into a single step.

## Degrees of Freedom Check

1. **Independently varying domain variables**
   - The set of entities and their event histories (a structural variable: entities appear/disappear, events are added/removed).
   - The aggregate value at each time point (derived from the entity set and event histories — not independently varying).

2. **Is the aggregate derivable from other state?**
   - Yes: the aggregate at time T is a deterministic function of the current entity set and their events. It need not be stored independently if recomputation is O(1). However, naïve recomputation at each time point is O(entities), and there are O(time_points) time points, making full recomputation O(entities × time_points) per input event. The step stores per-time-point aggregates to achieve O(1) per affected time point, which is justified.

3. **Internal state fields**
   - Per-entity sorted event list: represents an independently varying dimension (each entity's history).
   - Per-time-point aggregate value: derivable from entity histories, but stored to avoid O(N) recomputation. Acceptable under the AGENTS.md rule that permits caches that reduce time complexity.
   - No other fields are needed.

## Core Semantics

`timelineAggregate` is an **aggregate step** that consumes a two-level structure (entity collection → event sub-array) and produces a single-level timeline array.

For a given parent context (e.g., a class group):

- **Entities** are items in the entity collection. Each entity has an event sub-array.
- **Events** are items in the event sub-array, ordered lexicographically by the `orderBy` properties.
- **Time points** are the distinct `orderBy` tuples across all entities in the parent context.
- **Output** is one row per time point, where each row contains the sum of all entities' "latest as of" values for each aggregated property.

The entity's "latest value as of time T" for a property P is: the value of P on the entity's most recent event with `orderBy` tuple ≤ T. If the entity has no event at or before T, its contribution is 0.

## Public API

```ts
timelineAggregate(
  entityArrayName: string,
  eventArrayName: string,
  orderBy: string[],
  outputArrayName: string,
  properties: string[],
  outputProperties: string[]
)
```

Parameter roles:

- `entityArrayName` — the child array containing entities (e.g., `"attendees"`). Each entity in this array has a nested sub-array of events.
- `eventArrayName` — the sub-array within each entity containing time-ordered events (e.g., `"allocations"`).
- `orderBy` — one or more properties on each event that define chronological ordering. The first element is the primary sort key; subsequent elements break ties in order (e.g., `["createdAt", "id"]`). Must contain at least one property.
- `outputArrayName` — the name for the emitted timeline array (e.g., `"timeline"`).
- `properties` — which numeric properties on each event to aggregate (e.g., `["a0", "a1", "a2"]`).
- `outputProperties` — names for the aggregate values in the output (e.g., `["t0", "t1", "t2"]`). Must be same length as `properties`.

Validation:

- `orderBy.length` must be at least 1.
- Every property in `orderBy` must be a scalar in the event type.
- `properties.length` must equal `outputProperties.length`.
- `entityArrayName` must reference a child array in the current scope.
- `eventArrayName` must reference a child array within the entity type.

## Type Transformation

Input type (example after `groupBy(['effectiveClass'], 'byClass')`):

```
{
  effectiveClass: string,
  attendees: KeyedArray<{
    attendeePublicKey: string,
    attendeeEventId: string,
    allocations: KeyedArray<{ createdAt: string, a0: number, a1: number }>
  }>
}
```

Output type:

```
{
  effectiveClass: string,
  timeline: KeyedArray<{ createdAt: string, id: string, t0: number, t1: number }>
}
```

The entity array (`attendees`) is replaced by the timeline array (`timeline`). Parent-level scalars (`effectiveClass`) are preserved. Each timeline row carries the `orderBy` properties (`createdAt`, `id`) under their original names and types, plus the aggregate output properties.

## TypeDescriptor Transformation

The step transforms its input descriptor:

1. Remove the entity array descriptor (the array named `entityArrayName`).
2. Add a new array descriptor named `outputArrayName` with:
   - `collectionKey: [...orderBy]` (the `orderBy` properties are the bucket identity)
   - `scalars`: the `orderBy` properties (copied from the event type's scalar descriptors) followed by the output properties: `[...orderByScalars, {name: outputProperties[0]}, {name: outputProperties[1]}, ...]`
   - `mutableProperties: [...outputProperties]` (aggregate values change as events arrive)
   - `arrays: []`, `objects: []`
3. Preserve all other parent-level scalars, arrays, objects, and mutableProperties.

The `orderBy` properties become the `collectionKey` of the output array. This is the same pattern used by `groupBy`, where the grouping properties become the collection key. No synthetic `timeKey` field is needed — each timeline row carries the original ordering properties under their original names and types, and the pipeline's existing `collectionKey` mechanism handles identity and lookup.

Adding `outputProperties` to `mutableProperties` is required because the aggregate at a time bucket can change after the bucket is initially emitted (when subsequent events modify the aggregate). The `orderBy` properties are not mutable on the output — they are the bucket's identity.

## Step Taxonomy Classification

This step creates a new category:

| Category | What it does | Commutativity strategy | Example |
|----------|-------------|----------------------|---------|
| **Timeline Aggregate** | Collapses entity collection × event sub-array → timeline array of aggregates | Per-entity sorted event sets + per-time-point deterministic aggregation | TimelineAggregateStep |

It is most similar to an **aggregate step** (collapses a child array into a computed output) but operates on a two-level input and produces an array rather than a scalar.

## Internal State Model

Per parent context (e.g., per class group):

```
entityEvents: Map<entityKey, SortedList<Event>>
```

Each entity's events, maintained in sort order by lexicographic comparison of the `orderBy` tuple. Supports O(log N) insert/remove and O(1) predecessor/successor lookup.

```
timeBuckets: SortedMap<OrderByTuple, BucketState>
```

Where `OrderByTuple` is the composite key formed by the values of the `orderBy` properties (e.g., `["2026-01-01T10:00:00Z", "alloc-1"]` for `orderBy: ["createdAt", "id"]`), and `BucketState` holds:
- `referenceCount: number` — how many events across all entities share this `orderBy` tuple
- `aggregateValues: Record<string, number>` — the current aggregate for each output property

The `referenceCount` tracks how many events define this time point. A bucket exists while its reference count > 0. When the last event at a time point is removed, the bucket is removed.

These two structures are the minimal representation:
- `entityEvents` captures each entity's independently varying history (one field per independent variable).
- `timeBuckets` caches the per-time-point aggregate to avoid O(entities) recomputation. This is a derived cache justified by the performance constraint.

## Incremental Behavior

### Event added for entity E at time T with values V

1. Look up E's sorted event list. Find E's previous event before T (predecessor): `V_prev` (or 0 if none). Find E's next event after T (successor): `T_next` (or none).

2. Insert the event into E's sorted list. O(log N).

3. Compute the aggregate delta for the range `[T, T_next)`:
   - `delta[p] = V[p] - V_prev[p]` for each aggregated property `p`.

4. For each time bucket in the global `timeBuckets` with key in `[T, T_next)`:
   - If key = T and bucket does not exist: create it. Compute aggregate as `predecessor_bucket_aggregate + delta`. Increment reference count. Emit `onAdded` with the bucket's properties.
   - If key = T and bucket exists: increment reference count. Update aggregate by adding `delta`. Emit `onModified` with old and new aggregate values.
   - If key > T and key < T_next: update aggregate by adding `delta`. Emit `onModified`.

5. If `T_next` exists and `V_prev` differs from `V` (i.e., this insertion changes E's contribution at `T_next`): the delta at `T_next` changes. But the successor's delta is relative to T (now the new predecessor), not to E's old predecessor. This is handled by the fact that we only affect buckets in `[T, T_next)` — buckets at `T_next` and beyond are unaffected because E's "latest as of T_next" is still E's event at `T_next` (or later), not the newly inserted event.

### Event removed for entity E at time T with values V

Exact inverse of addition:

1. Find E's predecessor before T: `V_prev` (or 0 if none). Find E's successor after T: `T_next` (or none).

2. Remove the event from E's sorted list.

3. Compute `delta[p] = -(V[p] - V_prev[p])` (negated addition delta).

4. For each time bucket with key in `[T, T_next)`:
   - If key = T: decrement reference count. If count reaches 0, emit `onRemoved` and delete bucket. Otherwise, update aggregate by adding delta, emit `onModified`.
   - If key > T and key < T_next: update aggregate by adding delta, emit `onModified`.

### Entity added (with all its events)

Process each event in the entity's sub-array as an individual event addition, in chronological order. Since commutativity guarantees order independence, any processing order is correct, but chronological order minimizes intermediate state churn.

### Entity removed (with all its events)

Process each event as an individual event removal, in reverse chronological order.

### Downstream property modification on events

If an event's aggregated property changes via `onModified(property, oldValue, newValue)`:

1. Compute the value delta: `valueDelta = newValue - oldValue`.
2. Find the entity's next event after this event's time: `T_next`.
3. For each time bucket with key in `[T, T_next)`: update aggregate by adding `valueDelta`, emit `onModified`.

## Commutativity Guarantee

**Claim**: For any two orderings of add/remove operations on the same multiset of entities and events, the `TimelineAggregateStep` produces the same final set of (`orderBy` tuple, aggregateValues) rows.

**Proof**:

1. **Entity event sets are order-independent.** Each entity's `entityEvents` sorted list is a deterministic function of the current set of events for that entity (a set is order-independent by definition; the sorted list is a deterministic function of the set).

2. **Time bucket set is order-independent.** The set of time buckets with `referenceCount > 0` is determined by the union of all entities' event times. A set union is order-independent.

3. **Aggregate at each time bucket is order-independent.** For a time bucket at time T, the aggregate is:

   ```
   aggregate(T) = Σ over entities E of (E's latest value as of T)
   ```

   Each entity's "latest value as of T" is a deterministic function of E's current event set (the event with the greatest `orderBy` tuple ≤ T). Summation is commutative. Therefore the aggregate is a deterministic function of the current entity/event sets, independent of arrival order.

4. **Therefore**: same entity/event sets → same internal state → same output, regardless of operation order. QED.

## Complexity Analysis

Let:
- N = total events across all entities in a parent context
- K = number of global time buckets in the affected range `[T, T_next)` for one operation

| Operation | Sorted insert/remove | Range scan + updates | Total |
|-----------|---------------------|---------------------|-------|
| Event add | O(log N) | O(K) | O(log N + K) |
| Event remove | O(log N) | O(K) | O(log N + K) |
| Entity add (M events) | O(M log N) | O(M × K_avg) | O(M(log N + K_avg)) |
| Entity remove (M events) | O(M log N) | O(M × K_avg) | O(M(log N + K_avg)) |
| Point query | — | — | O(1) from KeyedArray |

For the LaunchKings use case: N ~ 200 events total, K typically 0-3 (few events between an entity's consecutive events), M = 1-3 events per entity. All operations are effectively O(1) at this scale.

**Memory**: O(N) for per-entity event lists + O(N) for time buckets = O(N) total.

## Full Pipeline Example

```ts
const classInfoPipeline = createPipeline<ClassRow, 'attendeeClasses'>('attendeeClasses')
    .groupBy(['attendeeEventId'], 'attendeeClasses');

const timelinePipeline = createPipeline<AllocationData, 'allocations'>('allocations')
    // Group allocations by attendee. Each attendee gets an "allocations" sub-array.
    .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')

    // Enrich each attendee with current class info (non-temporal dimension).
    .enrich('attendeeClasses', classInfoPipeline, ['attendeeEventId'], 'classInfo', defaults)
    .defineProperty('effectiveClass',
        a => a.classInfo.investorFlag === 1 ? 'investor' : 'general',
        ['classInfo'])
    .dropProperty('classInfo')

    // Group attendees by class. Each class group contains attendees with their allocations.
    .groupBy(['effectiveClass'], 'byClass')

    // Produce a time-series of aggregate allocations per class.
    .timelineAggregate(
        'attendees',                                      // entity collection
        'allocations',                                    // event sub-array per entity
        ['createdAt', 'id'],                              // orderBy (lexicographic)
        'timeline',                                       // output array
        ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'],           // properties to sum
        ['t0', 't1', 't2', 't3', 't4', 't5']            // output property names
    );
```

Output structure per class:

```
[
  { effectiveClass: "general", timeline: [
    { createdAt: "2026-01-01T10:00:00Z", id: "alloc-1", t0: 10, t1: 0, ... },
    { createdAt: "2026-01-01T10:05:00Z", id: "alloc-3", t0: 25, t1: 5, ... },
    ...
  ]},
  { effectiveClass: "investor", timeline: [
    { createdAt: "2026-01-01T10:02:00Z", id: "alloc-2", t0: 15, t1: 0, ... },
    ...
  ]}
]
```

Each timeline row's aggregate values are the sum of all entities' latest allocations as of that time point.

## Retroactive Class Changes

Because class is a current-state attribute (from `enrich`, not temporal), reclassification is handled by existing primitives:

1. Class changes for an attendee → `enrich` emits `onModified` for `classInfo`.
2. `defineProperty("effectiveClass")` recomputes → emits `onModified`.
3. `groupBy(["effectiveClass"])` detects the mutable grouping property change → removes the attendee from the old class group (`onRemoved`), adds to the new class group (`onAdded`).
4. `timelineAggregate` in the old class group processes the entity removal: removes all of that attendee's event contributions from affected time buckets.
5. `timelineAggregate` in the new class group processes the entity addition: adds all of that attendee's event contributions to affected time buckets.

All timeline points in both class groups are updated to reflect the reclassification. This is the correct behavior: the time series retroactively reflects the attendee's current class at every historical time point.

## Scope and Path Resolution

The step receives `scopeSegments` from the builder (passed as `this.scopeSegments` at construction time, following the same pattern as `CommutativeAggregateStep` and `GroupByStep`). All internal path computations are relative to this scope.

Three paths are derived from the scope and the step's parameters:

| Path | Derivation | Purpose |
|------|-----------|---------|
| Entity path | `[...scopeSegments, entityArrayName]` | Subscribe to entity add/remove in the collection |
| Event path | `[...scopeSegments, entityArrayName, eventArrayName]` | Subscribe to event add/remove within each entity |
| Output path | `[...scopeSegments, outputArrayName]` | Emit timeline bucket add/remove/modify; intercept downstream handler registrations |

When the builder method constructs the step, it computes these paths from its current scope:

```ts
const entityPath = [...this.scopeSegments, entityArrayName];
const eventPath = [...entityPath, eventArrayName];
```

The output path replaces the entity array in the scope. The builder resets `scopeSegments` to `[]` in the returned builder (standard for steps that restructure their output), so downstream steps see the timeline array at the root level.

If the caller uses `in()` to navigate into a nested scope before calling `timelineAggregate`, `scopeSegments` will be non-empty and all three paths shift accordingly. This is consistent with how `commutativeAggregate` resolves `fullSegmentPath = [...this.scopeSegments, arrayName]` and how `GroupByStep` receives `scopeSegments` to determine where in the tree it operates.

**Key path (runtime)** handling follows the same convention: entity-level handlers receive `keyPath` arrays that identify the specific parent context (e.g., the class group hash), and the step uses `computeKeyPathHash(parentKeyPath)` to key its internal state maps. Event-level handlers receive a `keyPath` that extends the entity-level path with the entity's key, allowing the step to associate events with their owning entity.

## Constructor: Upstream Registration

The step subscribes to its input using the resolved paths:

1. **Entity level** (entity path):
   - `onAdded`: entity appeared in the collection (e.g., attendee added to class group). Register the entity and process its existing events.
   - `onRemoved`: entity disappeared. De-register and remove its event contributions.

2. **Event level** (event path):
   - `onAdded`: new event for an entity. Update sorted list and time buckets.
   - `onRemoved`: event removed. Inverse update.

3. **Event property modifications** (if any `orderBy` property or any aggregated property is mutable):
   - `onModified` at the event path for each relevant property name.

## Handler Forwarding

The step intercepts registrations for:

- `onAdded`/`onRemoved`/`onModified` at the output path → captures handlers for timeline bucket events.
- All other path registrations → forwards to `this.input`.

This follows the aggregate step pattern: the step owns the output array path and forwards everything else.

## Correctness Invariants

1. **Aggregate accuracy.** For every time bucket at time T, the stored aggregate equals the sum of all entities' latest values as of T computed from scratch.
2. **Bucket existence.** A time bucket exists if and only if at least one entity has an event at that time.
3. **Entity isolation.** Adding or removing an event for entity E affects only time buckets in the range `[T, T_next)` where `T_next` is E's next event after T (or all buckets ≥ T if E has no later event).
4. **Exact inverse.** Removing an event exactly undoes the effect of adding it.
5. **Modification minimality.** `onModified` is emitted only for time buckets whose aggregate actually changed.

## Total Ordering Requirement

The `orderBy` tuple must be totally ordered and deterministic. Comparison is lexicographic: the first property in `orderBy` is the primary sort key; only when values are equal does comparison proceed to the next property, and so on.

The `orderBy` tuple determines:
- The chronological order of events within each entity.
- The identity of time buckets in the output (the `collectionKey` of the timeline array).

If the `orderBy` properties do not fully disambiguate events (e.g., `orderBy: ["createdAt"]` and two events from different entities share the same `createdAt`), those events share a single time bucket whose aggregate includes all of their contributions. Events from the same entity with identical `orderBy` tuples are ordered arbitrarily but deterministically (e.g., by insertion key). Adding more properties to `orderBy` (e.g., `["createdAt", "id"]`) increases disambiguation.

## Test Matrix

### Event-Level Operations

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Single entity, single event | One timeline bucket with the event's values |
| 2 | Single entity, two events (chronological add order) | Two buckets; first has event 1 values, second has event 2 values |
| 3 | Single entity, two events (reverse add order) | Same result as #2 |
| 4 | Two entities, non-overlapping times | Buckets at each entity's time; each includes only that entity's contribution |
| 5 | Two entities, overlapping times: A@t1, B@t2 | Bucket at t1 has A only; bucket at t2 has A's t1 value + B's t2 value |
| 6 | Replace semantics: A@t1=10, A@t3=20, B@t2=5 | t1=10, t2=15, t3=25 (the double-counting counterexample, verified correct) |
| 7 | Event removed (was latest for subsequent buckets) | Affected buckets' aggregates revert |
| 8 | Add then remove same event | Returns to prior state exactly |
| 9 | Collision on all `orderBy` properties (different entities) | Single bucket with sum of both entities' values |
| 10 | Primary `orderBy` property equal, secondary resolves | Distinct buckets ordered by secondary property |

### Entity-Level Operations

| # | Scenario | Expected |
|---|----------|----------|
| 11 | Entity added with pre-existing events | All events incorporated into timeline |
| 12 | Entity removed | All of entity's contributions removed from timeline |
| 13 | Entity moved between parent groups (class change) | Old group's timeline loses entity; new group's timeline gains entity |

### Commutativity

| # | Scenario | Expected |
|---|----------|----------|
| 14 | Three entities' events added in chronological order | Specific aggregate values at each time point |
| 15 | Same events added in reverse order | Identical result to #14 |
| 16 | Same events added in random order | Identical result to #14 |

### Edge Cases

| # | Scenario | Expected |
|---|----------|----------|
| 17 | No entities | Empty timeline |
| 18 | Entity with no events | No contribution to timeline |
| 19 | All events removed | Empty timeline |
| 20 | Property value of 0 | Contributes to aggregate (0 is a valid value, not "missing") |
| 21 | Null/undefined property value | Treated as 0 (consistent with `sum` behavior) |

## Alternatives Considered

### Two-Primitive Decomposition (LatestAsOfTimeline + CumulativeSum)

Rejected due to the composition correctness flaw described above. A delta-based variant could work but tightly couples the two steps (the first step's output is meaningless without the second), violating composability. The fused single-step design is simpler and correct by construction.

### Client-Side Replay

Sort all events, replay in a reducer. O(N) per new event. Correct but loses incremental maintenance. For the LaunchKings scale (< 200 events), this is viable as a short-term solution. The `timelineAggregate` step is warranted when incremental updates and reactive propagation through downstream steps (e.g., further enrichment or filtering of timeline data) are needed.

### Custom `commutativeAggregate` with Internal Timeline

Encode the entire timeline as a complex accumulator inside `commutativeAggregate`. The accumulator would be a serialized data structure rather than a scalar. This keeps the API surface unchanged but hides significant complexity, makes the output opaque to downstream steps, and prevents per-bucket `onAdded`/`onRemoved`/`onModified` emissions.
