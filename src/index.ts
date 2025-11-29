export type { Pipeline, Step, TypeDescriptor, ArrayDescriptor } from './pipeline';
export type { KeyedArray, Transform } from './builder';
export { PipelineBuilder } from './builder';
export { createPipeline } from './factory';

// Commutative aggregate types and step (for advanced usage)
export type { AddOperator, SubtractOperator } from './steps/commutative-aggregate';
export { CommutativeAggregateStep } from './steps/commutative-aggregate';

// Aggregate steps
export { MinMaxAggregateStep } from './steps/min-max-aggregate';
export { AverageAggregateStep } from './steps/average-aggregate';
export { PickByMinMaxStep } from './steps/pick-by-min-max';

// Filter step
export { FilterStep } from './steps/filter';

