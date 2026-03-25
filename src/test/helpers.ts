import { DescriptorNode, KeyedArray, Pipeline, PipelineBuilder, Transform } from '../index.js';

// Type helper to extract the output type from a PipelineBuilder
// and recursively convert KeyedArray properties to arrays
type ExtractKeyedArrays<T> = T extends KeyedArray<infer U>
    ? ExtractKeyedArrays<U>[]  // Convert KeyedArray<T> to T[]
    : T extends object
    ? {
          // For intersection types, we need to be more careful about which keys to include
          [K in keyof T]: T[K] extends KeyedArray<infer U>
              ? ExtractKeyedArrays<U>[]
              : ExtractKeyedArrays<T[K]>
      }
    : T;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BuilderOutputType<T> = T extends PipelineBuilder<infer U, any, any>
    ? ExtractKeyedArrays<U>
    : never;

// Helper function that uses type inference to set up a test pipeline
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTestPipeline<TBuilder extends PipelineBuilder<any, any, any>>(
    builderFactory: () => TBuilder
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): [Pipeline<any>, () => BuilderOutputType<TBuilder>[]] {
    const builder = builderFactory();
    type OutputType = BuilderOutputType<TBuilder>;
    // Use the actual output type from the builder, not the input type
    const [ getState, setState ] = simulateState<KeyedArray<OutputType>>([]);
    const typeDescriptor = builder.getTypeDescriptor();
    const runtimeSession = builder.build(setState);
    const getOutput = (): OutputType[] => {
        // Flush any pending batched updates before reading state
        // This ensures all changes are applied before test assertions
        runtimeSession.flush();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test helper: extract converts KeyedArray to plain array
        return extract(getState(), typeDescriptor);
    };
    return [runtimeSession, getOutput];
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

