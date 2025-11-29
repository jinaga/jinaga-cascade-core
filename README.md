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

## Development

This library is developed as part of the Cascade monorepo (`jinaga/cascade`). See the main repository for development setup.

## License

MIT

