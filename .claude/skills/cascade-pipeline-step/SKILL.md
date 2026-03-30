---
name: cascade-pipeline-step
description: Design and implement new pipeline steps for @jinaga/cascade-core. Use when creating a new Step class, adding a builder method to PipelineBuilder, or modifying the event propagation logic of an existing step. Covers the Step interface contract, three-channel event propagation (onAdded/onRemoved/onModified), TypeDescriptor transformation, builder integration, commutativity requirements, and testing patterns.
---

# Cascade Pipeline Step

Implement new pipeline steps that participate in cascade-core's incremental reactive pipeline. Each step has two classes: an immutable **Builder** that captures configuration, and a stateful **Step** that maintains runtime state. The `build()` method instantiates fresh Steps from Builders, wiring them into an independent pipeline session. Upstream add/remove calls trigger handlers registered at Step construction time, and the final step's emissions are batched into `KeyedArray` state by the runtime. See [Builder/Step Separation](../../docs/architecture/builder-step-separation.md) for the full design.

## Constraints

1. **Commutativity** — The same final `KeyedArray` must result regardless of the order `add`/`remove` are called. Output must be a deterministic function of the current item set, not the arrival order. See [Commutativity Strategies](references/step-patterns.md#commutativity-strategies) for per-step strategies and how to prove this property.
2. **Three-channel only** — Structural changes use `onAdded`/`onRemoved`. Mutable/computed values use `onModified`. No side-channel state.
3. **Exact inverses** — `remove(key, props)` must perfectly undo `add(key, props)`. The `onModified` handler carries `(oldValue, newValue)` so downstream steps can subtract the old contribution and add the new without full recomputation.
4. **No `_` prefix** on private members.
5. **Degrees of freedom** — Only introduce a new field if it represents an independently varying domain variable not captured by existing fields. If derivable from other state, derive on read. See `AGENTS.md`.

## Workflow

### 1. Classify the step

Determine which category the new step falls into. This dictates the handler-forwarding and descriptor patterns to follow.

| Category | What it does | Commutativity strategy | Examples |
|----------|-------------|----------------------|---------|
| **Transform** | Augments item properties | Pure function of current properties | DefinePropertyStep, FilterStep |
| **Aggregate** | Collapses array → scalar | `add`/`subtract` are commutative, associative inverses | CommutativeAggregateStep, sum, count |
| **Pick** | Collapses array → object | Heap determines extreme from current set | PickByMinMaxStep |
| **Structural** | Reshapes the tree | Deterministic hash partitioning | GroupByStep |
| **Join** | Cross-pipeline enrichment | Key-based join; re-emits on either side change | EnrichStep |

### 2. Write a red test first

Create a test file `src/test/pipeline.<step-name>.test.ts` using `createTestPipeline`:

```typescript
import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('myNewStep', () => {
    it('should produce correct output for a single item', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ group: string; value: number }>()
                .groupBy(['group'], 'items')
                .myNewStep('items', 'value', 'result')
        );

        pipeline.add('a', { group: 'G1', value: 10 });
        expect(getOutput()[0].result).toBe(/* expected */);
    });
});
```

**Required test scenarios:**
- Single item add
- Multiple items, correct combined result
- Remove → output reverts (inverse correctness)
- Different insertion orders → same final result (commutativity)
- Mutable property upstream change → downstream updates
- Empty/edge cases

### 3. Identify the commutativity strategy

Before writing code, state how the step guarantees order-independent output. This follows a standard structure:

1. What internal state does the step maintain?
2. Why is that state a deterministic function of the current item set (not arrival order)?
3. Why is the output a deterministic function of that state?

See [Commutativity Strategies](references/step-patterns.md#commutativity-strategies) for the proof template and examples.

If the step participates in a propagation chain (downstream of `pickByMax`, `defineProperty`, etc.), also verify that `onModified(oldValue, newValue)` provides sufficient information for incremental inverse computation. See [Mutable Property Propagation Chain](references/step-patterns.md#mutable-property-propagation-chain).

### 4. Implement the Step class

File: `src/steps/<step-name>.ts`

Read [step-patterns.md](references/step-patterns.md) for the detailed reference on each pattern below.

**Constructor** — Accept `input: Step`, `segmentPath`, `propertyName`, step-specific config, and any descriptor metadata required at runtime (for example upstream `TypeDescriptor` or derived mutable-property lists). Register `input.onAdded(segmentPath, ...)` and `input.onRemoved(segmentPath, ...)`. Register `input.onModified(...)` based on constructor metadata. Step constructors are called by the Builder's `buildGraph(ctx)` method during `build()`, not during the fluent method chain.

**Descriptor transform** — Keep descriptor shaping in Builder code (`getTypeDescriptor()`) as a pure transform from `this.upstream.getTypeDescriptor()`. Use helpers from `src/util/descriptor-transform.ts` (`appendObjectIfMissing`, `appendMutableIfMissing`, `emptyDescriptorNode`). Always add the output property to `mutableProperties` if it can change after initial add.

**onAdded/onRemoved** — Forward to `this.input` unless this step augments the payload at the matching scope (Transform/Join pattern) or manages structural layers (GroupBy pattern).

**onModified** — If `pathSegments` matches the parent path and `propertyName` matches this step's output property, capture the handler. Always also forward to `this.input` (except DefinePropertyStep which returns early for its synthetic property to prevent double-registration).

**State** — Use `Map<string, T>` keyed by `computeKeyPathHash(keyPath)`. Use `IndexedHeap` (from `src/util/indexed-heap.ts`) when O(log n) ordered access is needed.

**Emitting modifications** — Extract `parentKey` and `keyPathToParent` from the full `parentKeyPath`:

```typescript
if (parentKeyPath.length > 0) {
    const parentKey = parentKeyPath[parentKeyPath.length - 1];
    const keyPathToParent = parentKeyPath.slice(0, -1);
    this.modifiedHandlers.forEach(h => h(keyPathToParent, parentKey, oldValue, newValue));
} else {
    this.modifiedHandlers.forEach(h => h([], '', oldValue, newValue));
}
```

### 5. Add the Builder class

File: `src/steps/<step-name>.ts`, alongside the Step class

Create an immutable Builder that captures configuration and can produce a fresh Step graph:

```typescript
export class MyNewStepBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        readonly segmentPath: string[],
        readonly propertyName: string,
        readonly config: ...
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.upstream.getTypeDescriptor();
        return transformMyNewStepDescriptor(inputDescriptor, this.segmentPath, this.propertyName, this.config);
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

### 6. Add the PipelineBuilder method

File: `src/builder.ts`, class `PipelineBuilder`

Follow the existing pattern: construct the new Builder wrapping `this.lastBuilder`, return a new `PipelineBuilder` with the new builder and appropriate scope reset.

```typescript
myNewStep<
    ArrayName extends ArrayPropertyNameAtCurrentPath<T, Path>,
    PropName extends string
>(
    arrayName: ArrayName,
    propertyName: PropName,
    ...config
): PipelineBuilder</* transformed type */, TStart, Path, RootScopeName, TSources> {
    const fullSegmentPath = [...this.scopeSegments, arrayName];
    const newBuilder = new MyNewStepBuilder(this.lastBuilder, fullSegmentPath, propertyName, config);
    return new PipelineBuilder(this.rootBuilder, newBuilder, [] as unknown as Path, this.diagnosticBridge);
}
```

### 7. Export if needed

File: `src/index.ts` — Export the step class and any public types if the step is intended for advanced direct usage (not just via builder API).

### 8. Verify

- Run `npm test` and confirm the red test is now green.
- Add commutativity tests: same items, different add orders, assert identical `getOutput()`.
- Add inverse tests: add then remove, assert output reverts to prior state.
- Test composition with upstream mutable properties (e.g., after `pickByMax` or `defineProperty`).
- If the step emits O(K) modifications per input event, document the performance profile.

## Key Files

| File | Contains |
|------|----------|
| `src/pipeline.ts` | `Step` interface, `TypeDescriptor`, handler types, `getPathSegmentsFromDescriptor` |
| `src/builder.ts` | `PipelineBuilder`, `PipelineRuntimeSessionImpl`, `KeyedArray`, `build()` wiring |
| `src/factory.ts` | `createPipeline`, `InputBuilder`, `InputStep` |
| `src/util/descriptor-transform.ts` | `appendObjectIfMissing`, `appendMutableIfMissing`, `emptyDescriptorNode` |
| `src/util/path.ts` | `pathsMatch`, `pathStartsWith` |
| `src/util/indexed-heap.ts` | `IndexedHeap` — binary heap with O(log n) insert/removeById |
| `src/util/hash.ts` | `computeHash`, `computeGroupKey` |
| `src/test/helpers.ts` | `createTestPipeline`, `simulateState` |
| `src/steps/commutative-aggregate.ts` | Reference aggregate step |
| `src/steps/pick-by-min-max.ts` | Reference pick step (heap-based) |
| `src/steps/define-property.ts` | Reference transform step |
| `src/steps/group-by.ts` | Reference structural step |
| `src/steps/enrich.ts` | Reference join step |

## Detailed Patterns

See [references/step-patterns.md](references/step-patterns.md) for:
- **Commutativity strategies** — per-step strategy table, proof template, and `add`/`subtract` inverse requirements
- **Mutable property propagation chain** — how `onModified(old, new)` enables incremental inverse computation through multi-step chains (e.g., `pickByMax → defineProperty → sum`), and the rule on multiple emissions per input event
- **Constructor registration**, handler forwarding, key path management, modification emission, TypeDescriptor transformation, builder integration, and testing patterns
