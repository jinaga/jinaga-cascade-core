export type { Pipeline, Step, DescriptorNode, TypeDescriptor, ArrayDescriptor, ObjectDescriptor, ScalarType, ScalarDescriptor } from './pipeline.js';
export type { KeyedArray, Transform } from './builder.js';
export { PipelineBuilder } from './builder.js';
export { createPipeline } from './factory.js';

// Hash utilities
export { computeHash } from './util/hash.js';

// Commutative aggregate types and step (for advanced usage)
export type { AddOperator, SubtractOperator } from './steps/commutative-aggregate.js';
export { CommutativeAggregateStep } from './steps/commutative-aggregate.js';

// Aggregate steps
export { MinMaxAggregateStep } from './steps/min-max-aggregate.js';
export { AverageAggregateStep } from './steps/average-aggregate.js';
export { PickByMinMaxStep } from './steps/pick-by-min-max.js';

// Filter step
export { FilterStep } from './steps/filter.js';

