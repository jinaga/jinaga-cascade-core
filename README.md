# jinaga-cascade-core

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
npm install jinaga-cascade-core
```

## Usage

```typescript
import { PipelineBuilder } from 'jinaga-cascade-core';

// Build a pipeline
const pipeline = PipelineBuilder
  .from<InputType>()
  .filter(item => item.active)
  .groupBy(item => item.category)
  .aggregate('total', items => items.reduce((sum, item) => sum + item.value, 0))
  .build();

// Add data incrementally
pipeline.add('item-1', { active: true, category: 'A', value: 10 });
pipeline.add('item-2', { active: true, category: 'B', value: 20 });

// Subscribe to state updates
pipeline.onStateChange(state => {
  console.log('New state:', state);
});
```

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

## Development

This library is developed as part of the Cascade monorepo (`jinaga/cascade`). See the main repository for development setup.

## License

MIT

