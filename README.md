# @jinaga/cascade-core

Incremental, event-driven data pipeline system for Jinaga Cascade.

## Overview

This library provides a reactive data transformation pipeline system that processes data incrementally as it arrives, rather than in batch operations.

## Features

- **Incremental Processing**: Handle data changes one item at a time
- **Reactive State**: Maintains up-to-date state trees as data flows through pipelines
- **Type-Safe**: Built with TypeScript for full type safety
- **Composable**: Chain transformation steps using a fluent builder API

## Installation

```bash
npm install @jinaga/cascade-core
```

## Usage

```typescript
import { createPipeline } from '@jinaga/cascade-core';

type Vote = {
  attendeePublicKey: string;
  round: number;
  amount: number;
};

let state: unknown[] = [];
const setState = (transform: (state: any) => any) => {
  state = transform(state);
};

const runtimeSession = createPipeline<Vote, 'votes'>('votes')
  .groupBy(['attendeePublicKey'], 'attendees')
  .in('votes')
  .groupBy(['round'], 'rounds')
  .build(setState, {
    // Optional diagnostics hook
    onDiagnostic: diagnostic => console.warn(diagnostic)
  });

runtimeSession.add('vote-1', { attendeePublicKey: 'A', round: 1, amount: 10 });
runtimeSession.add('vote-2', { attendeePublicKey: 'A', round: 2, amount: 15 });

// Flush pending batched operations when you need deterministic reads.
runtimeSession.flush();
```

## Pipeline Lifecycle

Each `.build(...)` call returns a `Pipeline`:

- `add(key, immutableProps)`: adds an item to the pipeline
- `remove(key, immutableProps)`: removes an item from the pipeline
- `flush()`: drains queued operations immediately
- `dispose(options?)`: closes the pipeline and prevents further state updates
- `isDisposed()`: indicates whether the pipeline is closed

Recommended teardown behavior:

```typescript
// Drop pending work and close
runtimeSession.dispose();

// Or flush pending work first, then close
runtimeSession.dispose({ flush: true });
```

Nested adds with missing parents are handled deterministically (`warn` + drop with diagnostics).

## Mutable Property Auto-Detection

Aggregate methods automatically detect when the property being aggregated is mutable (computed by upstream pipeline steps) and handle updates accordingly.

### How It Works

When you create an aggregate like `sum('products', 'adjustedPrice', 'categoryTotal')`, the step checks if `adjustedPrice` is in the `TypeDescriptor.mutableProperties` array. If it is, the step automatically:

1. Subscribes to property change events for `adjustedPrice`
2. Updates the aggregate result when values change
3. Propagates changes to downstream steps

### Auto-Detection Methods

These methods automatically detect mutable properties:

| Method | Example | Auto-Detects |
|--------|---------|--------------|
| `sum()` | `.sum('items', 'price', 'total')` | `price` |
| `count()` | `.count('items', 'itemCount')` | N/A (counts items, not values) |
| `min()` | `.min('items', 'price', 'lowestPrice')` | `price` |
| `max()` | `.max('items', 'price', 'highestPrice')` | `price` |
| `average()` | `.average('items', 'price', 'avgPrice')` | `price` |
| `pickByMin()` | `.pickByMin('items', 'price', 'cheapest')` | `price` |
| `pickByMax()` | `.pickByMax('items', 'price', 'mostExpensive')` | `price` |

### Manual Methods (No Auto-Detection)

These methods require explicit `mutableProperties` because the dependencies can't be inferred from the function:

| Method | Example | Why Manual? |
|--------|---------|-------------|
| `defineProperty()` | `.defineProperty('status', item => item.total > 100 ? 'Gold' : 'Bronze', ['total'])` | Compute function is opaque |
| `filter()` | `.filter(item => item.isActive, ['isActive'])` | Predicate function is opaque |

### Cascading Updates

Auto-detection works across multiple pipeline levels:

```typescript
createPipeline<Order>()
    .groupBy(['category'], 'products')
    .in('products').groupBy(['productId'], 'orders')
    .in('products', 'orders').sum('items', 'price', 'orderTotal')  // orderTotal becomes mutable
    .in('products').sum('orders', 'orderTotal', 'productTotal')     // auto-detects orderTotal is mutable
    .sum('products', 'productTotal', 'categoryTotal')               // auto-detects productTotal is mutable
```

Changes at the lowest level (items.price) cascade up through all aggregate levels automatically.

## TypeScript: output shapes and React state

Use **`PipelineOutput<typeof builder>`** for the row type that matches `.build(setState)` (nested groups stay as `KeyedArray` properties). Use **`PipelinePlainOutput<typeof builder>`** for the same shape with every `KeyedArray` replaced by a plain array (for tests or read-only views).

The value passed to `setState` is `KeyedArray<Row>` where `Row` is the pipeline output type:

```typescript
import {
    createPipeline,
    type KeyedArray,
    type PipelineOutput,
    type PipelinePlainOutput
} from '@jinaga/cascade-core';
import { useState } from 'react';

const builder = createPipeline<{ category: string; sku: string; qty: number }>()
    .groupBy(['category'], 'items')
    .sum('items', 'qty', 'totalQty');

type Row = PipelineOutput<typeof builder>;
type SnapshotRow = PipelinePlainOutput<typeof builder>;

const [rows, setRows] = useState<KeyedArray<Row>>([]);

builder.build(transform => setRows(prev => transform(prev)));
```

## Development

This library is developed as part of the Cascade monorepo (`jinaga/cascade`). See the main repository for development setup.

## License

MIT

