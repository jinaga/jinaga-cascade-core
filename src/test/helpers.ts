import { DescriptorNode, KeyedArray, Pipeline, PipelineBuilder, Transform, type PipelinePlainOutput } from '../index.js';

// Helper function that uses type inference to set up a test pipeline
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTestPipeline<TBuilder extends PipelineBuilder<any, any, any>>(
    builderFactory: () => TBuilder
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): [Pipeline<any>, () => PipelinePlainOutput<TBuilder>[]] {
    const builder = builderFactory();
    type OutputType = PipelinePlainOutput<TBuilder>;
    // Use the actual output type from the builder, not the input type
    const [ getState, setState ] = simulateState<KeyedArray<OutputType>>([]);
    const typeDescriptor = builder.getTypeDescriptor();
    const pipeline = builder.build(setState);
    const getOutput = (): OutputType[] => {
        // Flush any pending batched updates before reading state
        // This ensures all changes are applied before test assertions
        pipeline.flush();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test helper: extract converts KeyedArray to plain array
        return extract(getState(), typeDescriptor);
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

// Extract items from KeyedArray, converting nested KeyedArrays to plain arrays
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test helper: returns dynamic structure based on descriptor
export function extract(state: KeyedArray<any>, typeDescriptor: DescriptorNode): any[] {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test helper: returns extracted values
    return state.map((item: { key: string; value: any }) => extractItem(item, typeDescriptor));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test helper: works with dynamic types from descriptors
function extractItem(item: { key: string; value: any; }, typeDescriptor: DescriptorNode): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test helper: dynamically construct result object
    const arrays: any = {};
    for (const arrayDescriptor of typeDescriptor.arrays) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- Dynamic property access for test helper
        const array = item.value[arrayDescriptor.name];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- Test helper: recursive extraction
        arrays[arrayDescriptor.name] = array ? extract(array, arrayDescriptor.type) : [];
    }
    return { ...item.value, ...arrays };
}

