# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript compilation (tsc)
npm run typecheck      # Type-check without emitting (tsc --noEmit)
npm test               # Run all tests (Jest)
npm test -- --testNamePattern="pattern"   # Run a single test by name
npm test -- path/to/file.test.ts          # Run a single test file
npm run test:watch     # Jest watch mode
npm run test:coverage  # Jest with coverage
npm run test:types     # Type definition tests (tsd)
npm run lint           # ESLint
npm run lint:fix       # ESLint with auto-fix
```

## Architecture

This is `@jinaga/cascade-core`, a pre-1.0 incremental event-driven data pipeline library. Pipelines receive `add`/`remove`/`modify` events and maintain transformed output state via a chain of steps.

### Builder/Step Separation

The core architectural pattern separates **immutable configuration** from **mutable runtime state**:

- **Builders** (`src/builder.ts`, step-specific builders in `src/steps/`) — Immutable objects created during the fluent API chain. They capture configuration and produce a `TypeDescriptor` describing the output shape. Calling `build()` creates a fresh runtime pipeline; builders are reusable across multiple `build()` calls.
- **Steps** (`src/steps/`) — Stateful runtime objects created by `buildGraph()`. They register `onAdded`/`onRemoved`/`onModified` handlers and maintain accumulators, indexes, etc. Steps are never shared across pipeline instances.
- **PipelineBuilder** (`src/builder.ts`) — The fluent entry point. Chains builder objects, then `build(setState)` produces a `Pipeline` that transforms events into output state via a `Transform<KeyedArray<T>>` callback.

### Key Types

- **`KeyedArray<T>`** — `Array<{ key: string; value: T }>`. The fundamental collection type preserving insertion order and identity.
- **`TypeDescriptor`** — Metadata about output shape: `arrays`, `scalars`, `collectionKey`, `mutableProperties`, `objects`. Drives both runtime behavior and compile-time type inference.
- **`PipelineOutput<TBuilder>`** — Infers the output row type from a builder's type parameters.
- **`PipelinePlainOutput<TBuilder>`** — Same but with `KeyedArray`s converted to plain arrays (for consumption).
- **`Pipeline`** — Runtime interface: `add(key, props)`, `remove(key, props)`, `flush()`, `dispose()`.

### Pipeline Steps (in `src/steps/`)

Each step follows the builder/step pattern. Key steps: `GroupBy`, `CommutativeAggregate` (sum/count), `MinMaxAggregate`, `AverageAggregate`, `CumulativeSum`, `PickByMinMax`, `DefineProperty`, `DropProperty`, `Filter`, `Flatten`, `Enrich`, `ReplaceToDelta`.

### Mutable Property Auto-Detection

Aggregate steps (`.sum()`, `.min()`, `.max()`, etc.) automatically detect when their input property is mutable and subscribe to modification events. This cascades: if step A produces a mutable output consumed by step B, step B auto-subscribes. Manual steps like `.defineProperty()` and `.filter()` require explicit `mutableProperties` because their dependency functions are opaque.

### Runtime Batching

`PipelineRuntimeSessionImpl` in `builder.ts` queues operations and flushes them in configurable batches (default 50 items, 16ms delay). Tests use `pipeline.flush()` to synchronously apply pending operations before assertions.

### Test Patterns

Tests live in `src/test/`. The `createTestPipeline()` helper in `src/test/helpers.ts` creates a pipeline and returns a `getOutput()` function that auto-flushes and converts to plain output for assertions. Tests follow the pattern:

```typescript
const [pipeline, getOutput] = createTestPipeline(() =>
    createPipeline<Item>().groupBy(['category'], 'items')
);
pipeline.add('k1', { category: 'A', value: 1 });
expect(getOutput()).toEqual([...]);
```

## Design Principles (from AGENTS.md)

- **Minimal degrees of freedom**: Every field must represent an independently varying domain variable. Derived values should be computed on read, not stored redundantly.
- **Correctness over compatibility**: This is pre-1.0. Default to semantic and type-system correctness over backward compatibility. No compatibility shims unless explicitly requested.
- **No speculative abstraction**: Do not introduce new runtime modes, options, flags, or alternate API paths unless explicitly requested.
