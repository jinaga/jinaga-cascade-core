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
export function createTestPipeline<
    T extends object,
    TStart,
    Path extends string[],
    RootScopeName extends string,
    TSources extends Record<string, unknown>
>(
    builderFactory: () => PipelineBuilder<T, TStart, Path, RootScopeName, TSources>
): [
    Pipeline<TStart, TSources>,
    () => PipelinePlainOutput<PipelineBuilder<T, TStart, Path, RootScopeName, TSources>>[]
] {
    const builder = builderFactory();
    type BuilderType = PipelineBuilder<T, TStart, Path, RootScopeName, TSources>;
    type RowType = PipelineOutput<BuilderType>;
    const [ getState, setState ] = simulateState<KeyedArray<RowType>>([]);
    const typeDescriptor = builder.getTypeDescriptor();
    const pipeline = builder.build(setState);
    const getOutput = (): PipelinePlainOutput<BuilderType>[] => {
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
