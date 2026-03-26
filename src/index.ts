export type {
    Pipeline,
    PipelineInput,
    Step,
    DescriptorNode,
    TypeDescriptor,
    ArrayDescriptor,
    ObjectDescriptor,
    ScalarType,
    ScalarDescriptor,
    PipelineRuntimeDiagnostic,
    PipelineRuntimeDisposeOptions,
    PipelineRuntimeOptions
} from './pipeline.js';
export type { KeyedArray, Transform, PipelineOutput, PipelinePlainOutput, PipelinePlainOutputShape } from './builder.js';
export { toPipelinePlainOutput } from './plain-output.js';
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

