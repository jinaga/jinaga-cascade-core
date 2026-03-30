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

Steps form a reactive chain where `onModified` events propagate downstream. Each link carries `(keyPath, key, oldValue, newValue)`, giving every downstream step enough information to compute its inverse without full recomputation.

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

The `ModifiedHandler` signature `(keyPath, key, oldValue, newValue)` is deliberate. It enables incremental updates without full recomputation:

- **Aggregates** subtract the old contribution and add the new: `newAcc = add(subtract(acc, oldItem), newItem)`. This is O(1) per modification rather than O(n) re-aggregation.
- **DefineProperty** uses old/new to detect whether the computed value actually changed, suppressing no-op emissions.
- **GroupBy** uses old/new grouping values to move an item from old group to new group (remove + add) rather than re-partitioning all items.

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
export type AddedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;
export type RemovedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;
export type ModifiedHandler = (keyPath: string[], key: string, oldValue: unknown, newValue: unknown) => void;

export interface Step {
    getTypeDescriptor(): TypeDescriptor;
    onAdded(pathSegments: string[], handler: AddedHandler): void;
    onRemoved(pathSegments: string[], handler: RemovedHandler): void;
    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void;
}
```

**Three event channels:**
- `onAdded` / `onRemoved` — structural membership changes (item appeared / disappeared)
- `onModified` — a named mutable property on an existing item changed

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
```

Every step must return a `TypeDescriptor` describing the shape of data it produces. Downstream steps and the runtime (`build()`) use this to:
- Discover which pathSegments exist (via `getPathSegmentsFromDescriptor`)
- Discover which properties are mutable (via `mutableProperties`)
- Wire up the correct `onAdded`/`onRemoved`/`onModified` registrations

**Key rule:** If a step produces a computed/aggregate property that can change after the initial `onAdded`, it must appear in `mutableProperties`. Otherwise downstream steps won't register `onModified` handlers for it.

---

## Constructor: Upstream Registration

Every Step registers listeners on its upstream `input` Step in the constructor. This wiring happens when `build()` instantiates fresh Steps from their Builders. Each `build()` call produces an independent Step graph with its own handler registrations and mutable state.

### Pattern: Listen for items at the target array level

```typescript
constructor(private input: Step, private segmentPath: string[], ...) {
    this.input.onAdded(this.segmentPath, (keyPath, itemKey, immutableProps) => {
        this.handleItemAdded(keyPath, itemKey, immutableProps);
    });
    this.input.onRemoved(this.segmentPath, (keyPath, itemKey, immutableProps) => {
        this.handleItemRemoved(keyPath, itemKey, immutableProps);
    });
}
```

### Pattern: Auto-detect mutable properties and register for changes

```typescript
const inputDescriptor = input.getTypeDescriptor();
const rootMutableProperties = inputDescriptor.mutableProperties;

if (rootMutableProperties.includes(propertyToWatch)) {
    this.input.onModified(this.segmentPath, propertyToWatch, (keyPath, itemKey, oldValue, newValue) => {
        this.handleItemPropertyChanged(keyPath, itemKey, oldValue, newValue);
    });
}
```

Check `inputDescriptor.mutableProperties` at the root level. Steps like `DefinePropertyStep` and `CommutativeAggregateStep` place their mutable properties at root level even when they logically belong to a nested array, so root-level checking is correct.

---

## Handler Forwarding

The `onAdded`/`onRemoved`/`onModified` methods serve two purposes:
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
```

### Pattern: DefineProperty/Enrich steps (augment onAdded payload)

The step wraps the `onAdded` handler to inject computed/enriched values into the payload:

```typescript
onAdded(pathSegments: string[], handler: AddedHandler): void {
    if (pathsMatch(pathSegments, this.scopeSegments)) {
        this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
            const computed = this.compute(immutableProps);
            handler(keyPath, key, { ...immutableProps, [this.propertyName]: computed });
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
        this.modifiedHandlers.push({ pathSegments, propertyName, handler });
        return; // Do NOT forward — this property is synthetic
    }
    this.input.onModified(pathSegments, propertyName, handler);
}
```

### Pattern: GroupBy (path rewriting)

GroupBy inserts a `groupKey` into keyPaths for nested paths, intercepting registrations and rewriting keyPaths in callbacks:

```typescript
onAdded(pathSegments: string[], handler: AddedHandler): void {
    if (this.isAtGroupLevel(pathSegments)) {
        this.groupAddedHandlers.push(handler);
    } else if (this.isAtItemLevel(pathSegments)) {
        this.itemAddedHandlers.push(handler);
    } else if (this.isBelowItemLevel(pathSegments)) {
        const shiftedSegments = pathSegments.slice(itemSegmentPath.length);
        this.input.onAdded([...this.scopeSegments, ...shiftedSegments], (keyPath, key, props) => {
            const groupKey = this.itemKeyToGroupKey.get(keyPath[this.scopeSegments.length]);
            const modifiedKeyPath = [...keyPath.slice(0, scopeLen), groupKey, ...keyPath.slice(scopeLen)];
            handler(modifiedKeyPath, key, props);
        });
    } else {
        this.input.onAdded(pathSegments, handler);
    }
}
```

---

## Key Path Management

Steps use `keyPath` (runtime key array) and `pathSegments` (schema-level array names) differently:

- **pathSegments** = array names in the TypeDescriptor tree (e.g. `['cities', 'venues']`)
- **keyPath** = runtime hash keys identifying a specific path through the data (e.g. `['hash_TX', 'hash_Dallas']`)

### Computing parent context

```typescript
function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

// Parent key path = keyPath as received (it's already the path to the parent context)
const parentKeyHash = computeKeyPathHash(parentKeyPath);
```

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

When a step needs to notify downstream that a property changed, it calls its stored `modifiedHandlers`. The emission pattern extracts `parentKey` and `keyPathToParent` from the full `parentKeyPath`:

```typescript
private emitModification(parentKeyPath: string[], oldValue: unknown, newValue: unknown): void {
    if (parentKeyPath.length > 0) {
        const parentKey = parentKeyPath[parentKeyPath.length - 1];
        const keyPathToParent = parentKeyPath.slice(0, -1);
        this.modifiedHandlers.forEach(handler => {
            handler(keyPathToParent, parentKey, oldValue, newValue);
        });
    } else {
        this.modifiedHandlers.forEach(handler => {
            handler([], '', oldValue, newValue);
        });
    }
}
```

---

## TypeDescriptor Transformation

Each step transforms its input descriptor to reflect the shape change it applies.

### Adding a mutable scalar property

```typescript
getTypeDescriptor(): TypeDescriptor {
    const inputDescriptor = this.input.getTypeDescriptor();
    const mutableProperties = inputDescriptor.mutableProperties.includes(this.propertyName)
        ? inputDescriptor.mutableProperties
        : [...inputDescriptor.mutableProperties, this.propertyName];
    return { ...inputDescriptor, mutableProperties };
}
```

### Adding an object property (enrich, pickByMinMax)

Use helper `appendObjectIfMissing` and `appendMutableIfMissing` from `src/util/descriptor-transform.ts`:

```typescript
import { appendObjectIfMissing, appendMutableIfMissing } from '../util/descriptor-transform.js';

getTypeDescriptor(): TypeDescriptor {
    const inputDescriptor = this.input.getTypeDescriptor();
    const objectDesc = { name: this.propertyName, type: sourceDescriptorNode };
    const withObject = appendObjectIfMissing(inputDescriptor, objectDesc);
    return appendMutableIfMissing(withObject, this.propertyName) as TypeDescriptor;
}
```

### Restructuring arrays (groupBy)

GroupBy splits scalars into parent-level (key properties) and child-level (non-key), creating a new nested array:

```typescript
return {
    rootCollectionName: this.parentArrayName,
    collectionKey: groupingKey,
    scalars: parentScalars,
    arrays: [{ name: this.childArrayName, type: { ...childDescriptor } }],
    mutableProperties: [...inputDescriptor.mutableProperties],
    objects: [...inputDescriptor.objects]
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
export class MyNewStepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        readonly segmentPath: string[],
        readonly propertyName: string,
        readonly config: ...
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        // Compute from upstream.getTypeDescriptor() and configuration
    }

    buildStep(input: Step): Step {
        return new MyNewStep(input, this.segmentPath, this.propertyName, this.config);
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
1. Walks the Builder chain from root to leaf, calling `buildStep(input)` on each to produce fresh Step instances
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

**GroupByStep**: splits items into groups by key properties, creating a new array nesting level. Intercepts all three channel registrations and rewrites keyPaths. Handles mutable grouping properties (re-group on change).

### Join steps (cross-pipeline enrichment)

**EnrichStep**: subscribes to both a primary `input` and a separate `secondary` step. Joins on key properties. Maintains secondary state as a `KeyedArray`. Emits `onModified` for the enriched property when either side changes.
