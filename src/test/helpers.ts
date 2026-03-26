import {
    KeyedArray,
    Pipeline,
    PipelineBuilder,
    Transform,
    toPipelinePlainOutput,
    type PipelineOutput,
    type PipelinePlainOutput
} from '../index.js';

// Helper function that uses type inference to set up a test pipeline
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTestPipeline<TBuilder extends PipelineBuilder<any, any, any, any, any>>(
    builderFactory: () => TBuilder
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): [Pipeline<any, any>, () => PipelinePlainOutput<TBuilder>[]] {
    const builder = builderFactory();
    type RowType = PipelineOutput<TBuilder>;
    const [ getState, setState ] = simulateState<KeyedArray<RowType>>([]);
    const typeDescriptor = builder.getTypeDescriptor();
    const pipeline = builder.build(setState);
    const getOutput = (): PipelinePlainOutput<TBuilder>[] => {
        // Flush any pending batched updates before reading state
        // This ensures all changes are applied before test assertions
        pipeline.flush();
        return toPipelinePlainOutput(getState(), typeDescriptor);
    };
    return [pipeline, getOutput];
}

export function simulateState<T>(initialState: T): [() => T, (transform: Transform<T>) => void] {
    let state: T = initialState;
    return [
        () => state,
        (transform: Transform<T>) => state = transform(state)
    ];
}
