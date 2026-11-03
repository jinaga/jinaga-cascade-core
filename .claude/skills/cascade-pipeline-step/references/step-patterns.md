# Cascade Pipeline Step Patterns

## Table of Contents

1. [Commutativity Strategies](#commutativity-strategies)
2. [Mutable Property Propagation Chain](#mutable-property-propagation-chain)
3. [Step Interface](#step-interface)
4. [TypeDescriptor System](#typedescriptor-system)
5. [Constructor: Upstream Registration](#constructor-upstream-registration)
6. [Handler Forwarding: onAdded / onRemoved / onModified](#handler-forwarding)
7. [Key Path Management](#key-path-management)
8. [Modification Emission](#modification-emission)
9. [TypeDescriptor Transformation](#typedescriptor-transformation)
10. [Builder Integration](#builder-integration)
11. [Testing Pattern](#testing-pattern)
12. [Step Taxonomy](#step-taxonomy)

---

## Commutativity Strategies

Each step type uses a different strategy to guarantee that the same final output results regardless of the order items are added or removed.

| Step | Strategy | Guarantee |
|------|----------|-----------|
| `CommutativeAggregateStep` | `add`/`subtract` are true inverses; `add` is commutative + associative | Same scalar regardless of order |
| `GroupByStep` | Deterministic hash partitioning on property values | Same groups regardless of order |
| `PickByMinMaxStep` | `IndexedHeap` (binary min-heap, O(log n) ops) | Same extreme regardless of order |
| `EnrichStep` | Key-based join; re-emits on either side change | Same join regardless of arrival order |
| `DefinePropertyStep` | Pure function of current item properties | Deterministic |
| `FilterStep` | Pure predicate of current item properties | Deterministic |

### Proving commutativity for a new step

Structure: Show that the step's output is a deterministic function of the *current set* of items, not the arrival order.

1. **Identify the internal state** — What data structure does the step maintain? (e.g., a sorted collection, a heap, a map of accumulators)
2. **Show the state is a function of the item set** — The data structure's contents after any sequence of adds/removes that produces a given item set S must be identical. A set is order-independent by definition.
3. **Show the output is a function of the state** — The emitted properties (via `onAdded` payload or `onModified` values) are derived deterministically from the internal state.
4. **Therefore** — Same item set → same state → same output, regardless of operation order. QED.

Example proof sketch for `PickByMinMaxStep`: The heap contains exactly the comparison values of the current item set. The heap's `peek()` returns the min/max regardless of insertion order. The materialized picked item is the item record corresponding to the heap's top entry. Same item set → same heap contents → same top → same picked item.

### Commutativity of `add`/`subtract` in aggregates

For `CommutativeAggregateStep`, the `add` operator must be commutative and associative:
- **Commutative**: `add(add(acc, A), B) = add(add(acc, B), A)`
- **Associative**: grouping doesn't matter
- **Inverse**: `subtract(add(acc, A), A) = acc`

The built-in `sum` satisfies these trivially (addition of numbers). Custom aggregates must prove these properties hold for their operators.

---

## Mutable Property Propagation Chain

Steps form a reactive chain where `onModified` events propagate downstream. Each link carries `(key, oldValue, newValue)`, giving every downstream step enough information to compute its inverse without full recomputation.

### Example: pickByMax → defineProperty → sum

```
pickByMax watches its heap →
  emits onModified("latestAllocation", oldPicked, newPicked)

defineProperty("a0", ...) listens for onModified("latestAllocation") →
  recomputes: a0_new = extract(newPicked), a0_old = extract(oldPicked)
  emits onModified("a0", a0_old, a0_new)

sum("attendees", "a0", "t0") listens for onModified("a0") →
  calls subtract(acc, {a0: a0_old}) then add(acc, {a0: a0_new})
  emits onModified("t0", oldSum, newSum)
```

### Why old + new values matter

The `ModifiedHandler` signature `(key, oldValue, newValue)` is deliberate. It enables incremental updates without full recomputation:

- **Aggregates** subtract the old contribution and add the new: `newAcc = add(subtract(acc, oldItem), newItem)`. This is O(1) per modification rather than O(n) re-aggregation.
- **DefineProperty** uses old/new to detect whether the computed value actually changed, suppressing no-op emissions.
- **GroupBy** uses the new grouping value to move an item to its new group with one `onPlaced` event. The item's values and descendants are untouched, so nothing is re-emitted.

### Multiple emissions per input event

A single `pipeline.add()` call propagates synchronously through the chain. Each step may emit zero, one, or multiple `onModified` calls per input event:

- `CommutativeAggregateStep` emits exactly **one** `onModified` per add/remove (the aggregate changed)
- `PickByMinMaxStep` emits exactly **one** `onModified` per add/remove (the picked item may have changed)
- A step over an ordered dimension could emit **O(K)** `onModified` calls if K downstream buckets are affected

Multiple emissions per input event are architecturally compatible — there is no constraint limiting a step to one emission. However, steps with O(K) emissions per input event change the pipeline's overall performance profile, so this should be documented.

---

## Step Interface

File: `src/pipeline.ts`

```typescript
export type ImmutableProps = { [key: string]: unknown };
export type AddedHandler = (parentKey: string | undefined, key: string, immutableProps: ImmutableProps) => void;
export type RemovedHandler = (key: string, immutableProps: ImmutableProps) => void;
export type ModifiedHandler = (key: string, oldValue: unknown, newValue: unknown) => void;
export type PlacedHandler = (key: string, oldParentKey: string, newParentKey: string) => void;

export interface Step {
    onAdded(pathSegments: string[], handler: AddedHandler): void;
    onRemoved(pathSegments: string[], handler: RemovedHandler): void;
    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void;
    onPlaced(pathSegments: string[], handler: PlacedHandler): void;
}
```

**Identity and placement.** A node is identified by its level (`pathSegments`) and its `key`. Keys are unique within a level across the whole pipeline: root keys by contract, and every key a step creates below the root is derived from the parent's key (`computeChildKey`). A node's parent is its *placement*, a changeable value. See [Placement](../../../../docs/architecture/placement.md).

**Four event channels:**
- `onAdded` — a node appeared under `parentKey` (undefined at the root level). The payload carries the node's complete current values.
- `onRemoved` — a node disappeared.
- `onModified` — a named mutable property of an existing node changed.
- `onPlaced` — a node at a nested level moved to another parent. Its descendants keep their own placement, so they do not move separately.

**pathSegments** identifies which logical array path in the type tree the subscriber cares about (e.g. `[]` for root, `['cities', 'venues']` for nested array). Steps compare or prefix-match these to decide whether to handle or forward.

---

## TypeDescriptor System

File: `src/pipeline.ts`

```typescript
export interface DescriptorNode {
    arrays: ArrayDescriptor[];
    collectionKey: string[];
    scalars: ScalarDescriptor[];
    objects: ObjectDescriptor[];
    mutableProperties: string[];
}

export interface TypeDescriptor extends DescriptorNode {
    rootCollectionName: string;
}

export interface ArrayDescriptor {
    name: string;
    type: DescriptorNode;
    /** Whether an item of this array can move to another parent after it is added. */
    mutablePlacement: boolean;
}
```

Every step must return a `TypeDescriptor` describing the shape of data it produces. Downstream steps and the runtime (`build()`) use this to:
- Discover which pathSegments exist (via `getPathSegmentsFromDescriptor`)
- Discover which properties are mutable (via `mutableProperties`)
- Wire up the correct `onAdded`/`onRemoved`/`onModified` registrations

**Key rule:** If a step produces a computed/aggregate property that can change after the initial `onAdded`, it must appear in the `mutableProperties` of the level it belongs to. Otherwise downstream steps won't register `onModified` handlers for it.

**Placement rule:** A step that emits `onPlaced` at a level must set `mutablePlacement: true` on that level's `ArrayDescriptor`. A step that only forwards moves must keep the flag: rebuild an array with `{ ...arrayDesc, type }`, never `{ name, type }`. A value that depends on a node's parent (as `flatten`'s inherited values do) is mutable when that node's array has `mutablePlacement`. See `docs/architecture/placement.md`.

---

## Constructor: Upstream Registration

Every Step registers listeners on its upstream `input` Step in the constructor. This wiring happens when `build()` instantiates fresh Steps from their Builders. Each `build()` call produces an independent Step graph with its own handler registrations and mutable state.

### Pattern: Listen for items at the target array level

```typescript
constructor(private input: Step, private segmentPath: string[], ...) {
    this.input.onAdded(this.segmentPath, (parentKey, itemKey, immutableProps) => {
        this.handleItemAdded(parentKey, itemKey, immutableProps);
    });
    this.input.onRemoved(this.segmentPath, itemKey => {
        this.handleItemRemoved(itemKey);
    });
    this.input.onPlaced(this.segmentPath, (itemKey, oldParentKey, newParentKey) => {
        this.handleItemPlaced(itemKey, newParentKey);
    });
}
```

### Pattern: Auto-detect mutable properties and register for changes

```typescript
// The mutable properties of the items this step listens to, at their own level.
const itemMutableProperties = getMutablePropertiesOfArrayItems(inputDescriptor, this.segmentPath);

if (itemMutableProperties.includes(propertyToWatch)) {
    this.input.onModified(this.segmentPath, propertyToWatch, (itemKey, oldValue, newValue) => {
        this.handleItemPropertyChanged(itemKey, oldValue, newValue);
    });
}
```

Read upstream `mutableProperties` at the level the step listens to (`getMutablePropertiesOfArrayItems`). Each level records only its own items' properties, so a same-named property at another level says nothing about this one. Builders pass descriptor metadata into Step constructors (for example as an `inputDescriptor` constructor argument), and steps use that metadata for registration decisions.

---

## Handler Forwarding

The `onAdded`/`onRemoved`/`onModified`/`onPlaced` methods serve two purposes:
1. **Capture handlers** for this step's own output properties
2. **Forward to `this.input`** for anything this step doesn't own

### Pattern: Aggregate/pick steps (property at parent level)

The step intercepts handlers for its own property at the parent path level, and forwards everything else:

```typescript
onAdded(pathSegments: string[], handler: AddedHandler): void {
    this.input.onAdded(pathSegments, handler);
}

onRemoved(pathSegments: string[], handler: RemovedHandler): void {
    this.input.onRemoved(pathSegments, handler);
}

onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
    if (this.isParentPath(pathSegments) && propertyName === this.propertyName) {
        this.modifiedHandlers.push(handler);
    }
    this.input.onModified(pathSegments, propertyName, handler);
}

onPlaced(pathSegments: string[], handler: PlacedHandler): void {
    this.input.onPlaced(pathSegments, handler);
}
```

### Pattern: DefineProperty/Enrich steps (augment onAdded payload)

The step wraps the `onAdded` handler to inject computed/enriched values into the payload:

```typescript
onAdded(pathSegments: string[], handler: AddedHandler): void {
    if (pathsMatch(pathSegments, this.scopeSegments)) {
        this.input.onAdded(pathSegments, (parentKey, key, immutableProps) => {
            const computed = this.compute(immutableProps);
            handler(parentKey, key, { ...immutableProps, [this.propertyName]: computed });
        });
    } else {
        this.input.onAdded(pathSegments, handler);
    }
}
```

### Pattern: DefineProperty (intercept onModified for synthetic property)

```typescript
onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
    if (propertyName === this.propertyName && pathsMatch(pathSegments, this.scopeSegments)) {
        this.modifiedHandlers.push(handler);
        return; // Do NOT forward — this property is synthetic
    }
    this.input.onModified(pathSegments, propertyName, handler);
}
```

### Pattern: GroupBy (placement)

GroupBy owns the group level and the item level. Paths below the item level map to the input by replacing the item level with the scope; keys pass through unchanged, because a descendant's parent is the item, not the group.

```typescript
onAdded(pathSegments: string[], handler: AddedHandler): void {
    if (this.isAtGroupLevel(pathSegments)) {
        this.groupAddedHandlers.push(handler);
    } else if (this.isAtItemLevel(pathSegments)) {
        this.itemAddedHandlers.push(handler);
    } else {
        this.input.onAdded(this.toInputPath(pathSegments), handler);
    }
}
```

When a grouping value changes, the item moves: the new group is added if needed, `onPlaced(item, oldGroup, newGroup)` is emitted, and the old group is removed if it is now empty.

---

## State Keys

Steps use `pathSegments` (schema-level array names) to register, and node keys to track state:

- **pathSegments** = array names in the TypeDescriptor tree (e.g. `['cities', 'venues']`)
- **key** = a node's key, unique within its level
- **parentKey** = the node's placement, delivered by `onAdded` and changed by `onPlaced`

Key per-item state by the item's key and store its `parentKey` in that record. Key per-parent state (an aggregate, a heap, a sorted list) by the parent's key. Never key state by a path of ancestors: an ancestor can move without notifying the item.

### isParentPath helper

Aggregate and pick steps output their property at the **parent** of the array they consume. To detect if a handler registration targets this parent level:

```typescript
private isParentPath(pathSegments: string[]): boolean {
    const parentSegments = this.segmentPath.slice(0, -1);
    if (pathSegments.length !== parentSegments.length) return false;
    return pathSegments.every((segment, i) => segment === parentSegments[i]);
}
```

---

## Modification Emission

Aggregate and pick steps emit at the parent level, addressed by the parent's key:

```typescript
private emit(parentKey: string, oldValue: unknown, newValue: unknown): void {
    this.modifiedHandlers.forEach(handler => handler(parentKey, oldValue, newValue));
}
```

On `onPlaced(item, oldParent, newParent)`, remove the item's contribution from `oldParent`, add it to `newParent`, and emit for both.

---

## TypeDescriptor Transformation

Each Builder transforms the upstream descriptor to reflect the shape change it applies.

### Adding a mutable scalar property

Write the property to the level it belongs to. An aggregate over the items at `segmentPath` belongs to their parent:

```typescript
getTypeDescriptor(): TypeDescriptor {
    return appendAggregateAt(this.upstream.getTypeDescriptor(), this.segmentPath, this.propertyName);
}
```

For any other level, use `updateNodeAt(descriptor, path, node => ...)` with `appendScalarIfMissing` and `appendMutableIfMissing`.

### Adding an object property (enrich, pickByMinMax)

Use helper `appendObjectIfMissing` and `appendMutableIfMissing` from `src/util/descriptor-transform.ts`:

```typescript
import { appendObjectIfMissing, appendMutableIfMissing } from '../util/descriptor-transform.js';

function transformDescriptor(inputDescriptor: TypeDescriptor, scopeSegments: string[]): TypeDescriptor {
    const objectDesc = { name: propertyName, type: sourceDescriptorNode };
    return updateNodeAt(inputDescriptor, scopeSegments, node =>
        appendMutableIfMissing(appendObjectIfMissing(node, objectDesc), propertyName)
    );
}
```

### Restructuring arrays (groupBy)

GroupBy splits a level's items into groups. The group level holds only the grouping values, which never change, so it has no mutable properties and no objects. The items keep their other scalars, arrays, objects and mutable properties (less the grouping keys), and their array records whether they can move:

```typescript
return {
    ...emptyDescriptorNode(),
    collectionKey: groupingProperties,
    scalars: groupingScalars,
    arrays: [{
        name: childArrayName,
        type: { ...items, scalars: otherScalars, mutableProperties: otherMutableProperties },
        mutablePlacement: groupingValueMutable || itemsMove
    }]
};
```

---

## Builder Integration

File: `src/builder.ts`, class `PipelineBuilder`

Each pipeline step has two classes: an immutable **Builder** (captures configuration) and a stateful **Step** (maintains runtime state). See [Builder/Step Separation](../../../docs/architecture/builder-step-separation.md).

Each fluent method on `PipelineBuilder`:
1. Constructs a new **Builder** wrapping `this.lastBuilder`
2. Returns `new PipelineBuilder(this.rootBuilder, newBuilder, scopeSegments, this.diagnosticBridge)`

Builders are immutable and hold no mutable state. Steps are created later by `build()`.

### Scope segments

- Most methods reset scope to `[]` (the returned builder operates at root)
- `in(...segments)` extends scope and returns the same `lastBuilder` (navigation only)
- The Builder captures `scopeSegments` so the Step constructor receives them at `build()` time

### Pattern: Adding a Builder class

```typescript
export class MyNewStepBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        readonly segmentPath: string[],
        readonly propertyName: string,
        readonly config: ...
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return transformMyNewStepDescriptor(
            this.upstream.getTypeDescriptor(),
            this.segmentPath,
            this.propertyName,
            this.config
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new MyNewStep(
                up.lastStep,
                this.segmentPath,
                this.propertyName,
                this.config,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
```

### Pattern: Adding a PipelineBuilder method

```typescript
myNewStep<ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>, PropName extends string>(
    arrayName: ArrayName,
    propertyName: PropName,
    ...config
): PipelineBuilder<TransformedType, TStart, Path, RootScopeName, TSources> {
    const fullSegmentPath = [...this.scopeSegments, arrayName];
    const newBuilder = new MyNewStepBuilder(
        this.lastBuilder,
        fullSegmentPath,
        propertyName,
        config
    );
    return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
}
```

### How build() instantiates Steps and wires the session

`build()` in `PipelineBuilder`:
1. Calls `buildGraph(ctx)` on the last builder, which recursively builds the entire Step graph from root to leaf
2. Gets all path segments from the final Step's TypeDescriptor
3. For each path, registers `onAdded` → `session.enqueueAdd`, `onRemoved` → `session.enqueueRemove`
4. Collects all mutable properties via `collectAllMutableProperties(descriptor)`
5. For each mutable property at each path level (including parent), registers `onModified` → `session.enqueueModify`

Because every `build()` call constructs new Step instances, two calls produce fully independent pipeline graphs with no shared state.

---

## Testing Pattern

File: `src/test/helpers.ts`

```typescript
import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

const [pipeline, getOutput] = createTestPipeline(() =>
    createPipeline<MyItemType, 'items'>('items')
        .groupBy(['category'], 'items')
        .myNewStep('items', 'price', 'result')
);

pipeline.add('item1', { category: 'A', price: 100 });
pipeline.add('item2', { category: 'A', price: 200 });

const output = getOutput();
expect(output).toHaveLength(1);
expect(output[0].result).toBe(300);
```

### Testing secondary sources (enrich)

```typescript
const sources = (pipeline as unknown as {
    sources: { mySource: { add: (key: string, props: SourceRow) => void } };
}).sources;
sources.mySource.add('key1', { ... });
```

### What to test

- Add single item → correct initial output
- Add multiple items → correct combined output
- Remove item → output reverts correctly (inverse)
- Order independence → same items added in different orders produce same output
- Mutable property change → downstream updates correctly
- Edge cases → empty arrays, null/undefined values, tie-breaking

---

## Step Taxonomy

### Transform steps (augment item properties)

**DefinePropertyStep**, **FilterStep**: operate at `scopeSegments`, wrap `onAdded` payload, track items for recomputation on mutable changes. Do NOT consume arrays — they add/filter properties at the current level.

### Aggregate steps (collapse array → scalar)

**CommutativeAggregateStep**, **MinMaxAggregateStep**, **AverageAggregateStep**: listen at `segmentPath` for array items, maintain accumulator per parent, emit `onModified` at parent level for the aggregate property. Replace the array with a scalar in the TypeDescriptor.

### Pick steps (collapse array → object)

**PickByMinMaxStep**: like aggregates but output is an object (the "winner" row) instead of a scalar. Uses `IndexedHeap` for O(log n) winner tracking. Emits full picked-item object via `onModified`.

### Structural steps (reshape the tree)

**GroupByStep**: splits items into groups by key properties, creating a new array nesting level. Owns the group and item levels and forwards everything below the item level unchanged. A change to a mutable grouping property moves the item with `onPlaced`.

### Join steps (cross-pipeline enrichment)

**EnrichStep**: subscribes to both a primary `input` and a separate `secondary` step. Joins on key properties. Maintains secondary state as a `KeyedArray` located through a `PlacementIndex`. Emits `onModified` for the enriched property when either side changes.
