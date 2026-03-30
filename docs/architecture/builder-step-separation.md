# Builder/Step Separation

## Problem

In the current architecture, `PipelineBuilder` methods eagerly construct Step class instances during the fluent method chain. The same Step instances are then wired to the runtime session when `build()` is called. Because Step instances are stateful (they maintain Maps of tracked items, handler arrays, aggregate accumulators, etc.), calling `build()` twice on the same `PipelineBuilder` produces two pipelines that share internal state. Shared state causes cross-session corruption: items tracked by the first session leak into the second, handler arrays accumulate duplicate registrations, and aggregate values carry over stale data.

## Design

Separate each pipeline step into two classes:

- **Builder** — Immutable. Captures the configuration needed to create a Step (segment paths, property names, operator functions, comparators). Created once during the fluent method chain. Shared safely across multiple `build()` calls.
- **Step** — Stateful. Maintains runtime state (handler arrays, tracked items, aggregate accumulators). Created fresh by `build()` for each pipeline session. Never shared between sessions.

### Invariants

1. Builders hold no mutable state. All fields are `readonly` and set in the constructor.
2. Each `build()` call produces a complete, independent graph of Step instances. No Step instance is reused across calls.
3. Pipelines share no state between them.

## Builder Classes

For each existing Step class, define a corresponding Builder class in the same file:

| Builder | Step | File |
|---------|------|------|
| `GroupByBuilder` | `GroupByStep` | `src/steps/group-by.ts` |
| `FilterBuilder` | `FilterStep` | `src/steps/filter.ts` |
| `DefinePropertyBuilder` | `DefinePropertyStep` | `src/steps/define-property.ts` |
| `DropPropertyBuilder` | `DropPropertyStep` | `src/steps/drop-property.ts` |
| `CommutativeAggregateBuilder` | `CommutativeAggregateStep` | `src/steps/commutative-aggregate.ts` |
| `MinMaxAggregateBuilder` | `MinMaxAggregateStep` | `src/steps/min-max-aggregate.ts` |
| `AverageAggregateBuilder` | `AverageAggregateStep` | `src/steps/average-aggregate.ts` |
| `PickByMinMaxBuilder` | `PickByMinMaxStep` | `src/steps/pick-by-min-max.ts` |
| `EnrichBuilder` | `EnrichStep` | `src/steps/enrich.ts` |
| `CumulativeSumBuilder` | `CumulativeSumStep` | `src/steps/cumulative-sum.ts` |
| `ReplaceToDeltaBuilder` | `ReplaceToDeltaStep` | `src/steps/replace-to-delta.ts` |
| `FlattenBuilder` | `FlattenStep` | `src/steps/flatten.ts` |
| `InputBuilder` | `InputStep` | `src/factory.ts` |

### Builder Interface

Every Builder implements:

```ts
interface StepBuilder {
    getTypeDescriptor(): TypeDescriptor;
    buildStep(input: Step): Step;
}
```

- `getTypeDescriptor()` returns the output shape of the step, computed from the configuration and the upstream builder's descriptor. This is called during the fluent method chain to support validation and type inference.
- `buildStep(input)` constructs a fresh Step wired to the given upstream Step. This is called during `build()` to instantiate the runtime graph.

The `InputBuilder` is special: it has no upstream builder. Its `buildStep` creates the `InputStep` that serves as both the root `Step` and the `PipelineInput`.

### Builder Structure

A Builder captures only the immutable configuration that its Step needs:

```ts
class GroupByBuilder<T, K extends keyof T, ParentArrayName extends string, ChildArrayName extends string> {
    constructor(
        readonly upstream: StepBuilder,
        readonly groupingProperties: K[],
        readonly parentArrayName: ParentArrayName,
        readonly childArrayName: ChildArrayName,
        readonly scopeSegments: string[]
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        // Compute from upstream.getTypeDescriptor() and configuration
    }

    buildStep(input: Step): Step {
        return new GroupByStep(input, this.groupingProperties, this.parentArrayName,
            this.childArrayName, this.scopeSegments);
    }
}
```

### Step Class Changes

Step constructors change from accepting `input: Step` as the upstream (and registering handlers in the constructor) to receiving the upstream Step from `buildStep`. The Step class itself is unchanged in behavior — it still registers handlers in its constructor, maintains mutable state, and implements the `Step` interface.

## PipelineBuilder Changes

`PipelineBuilder` currently stores `lastStep: Step`. Under the new design, it stores `lastBuilder: StepBuilder` instead. The `input: PipelineInput` field is also replaced by the root `InputBuilder`.

Each fluent method creates a new Builder (not a new Step):

```ts
groupBy<K extends keyof NavigateToPath<T, Path>, ArrayName extends string>(
    groupingProperties: K[],
    arrayName: ArrayName
): PipelineBuilder<...> {
    const inferredChildArrayName = ...;
    const newBuilder = new GroupByBuilder(
        this.lastBuilder,
        groupingProperties,
        arrayName,
        inferredChildArrayName,
        this.scopeSegments
    );
    return new PipelineBuilder(this.rootBuilder, newBuilder, ...);
}
```

### build()

`build()` walks the builder chain from root to leaf, calling `buildStep` on each builder to produce a fresh Step graph:

```ts
build(
    setState: (transform: Transform<KeyedArray<T>>) => void,
    runtimeOptions: PipelineRuntimeOptions = {}
): Pipeline<TStart, TSources> {
    // 1. Instantiate all Steps from Builders
    const rootStep = this.rootBuilder.buildStep();
    const lastStep = this.lastBuilder.buildChain(rootStep);

    // 2. Wire the last step to a new runtime session
    const session = new PipelineRuntimeSessionImpl(rootStep, setState, runtimeOptions);
    // ... register handlers on lastStep for each path segment
    return session;
}
```

Because every `build()` call constructs new Step instances, two calls produce two fully independent pipeline graphs.

### getTypeDescriptor()

`PipelineBuilder.getTypeDescriptor()` delegates to `this.lastBuilder.getTypeDescriptor()`. Since builders are immutable and type descriptors are computed from configuration, this works identically to the current design.

## Validation

Steps that perform build-time validation (e.g., `CumulativeSumStep` checking that `orderBy` properties are scalars, `ReplaceToDeltaStep` checking for name collisions) perform that validation in the Builder's constructor or `getTypeDescriptor()`. This keeps validation at definition time, not deferred to `build()`.

## Enrich and Source Wiring

`EnrichBuilder` captures the secondary `StepBuilder` chain (from the secondary `PipelineBuilder`). At `build()` time, the secondary builder chain is also instantiated into fresh Steps. Source routing (the `sources` property on `Pipeline`) is wired to the freshly created secondary `InputStep`.

## Degrees of Freedom

This design adds one new concept (the Builder class) per existing Step class. This is justified because it represents a genuinely independent variable: the immutable configuration vs. the mutable runtime state. The current design conflates these two roles into a single class, which is the root cause of the shared-state bug.

No new runtime modes, flags, or alternate API paths are introduced. The public API (`createPipeline`, `PipelineBuilder` methods, `build()`, `Pipeline`) is unchanged.
