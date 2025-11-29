import { KeyedArray, Pipeline, PipelineBuilder, Transform, TypeDescriptor } from '../index';

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

export type BuilderOutputType<T> = T extends PipelineBuilder<infer U, any, any>
    ? ExtractKeyedArrays<U>
    : never;

// Helper function that uses type inference to set up a test pipeline
export function createTestPipeline<TBuilder extends PipelineBuilder<any, any, any>>(
    builderFactory: () => TBuilder
): [Pipeline<any>, () => BuilderOutputType<TBuilder>[]] {
    const builder = builderFactory();
    type OutputType = BuilderOutputType<TBuilder>;
    // Use the actual output type from the builder, not the input type
    const [ getState, setState ] = simulateState<KeyedArray<OutputType>>([]);
    const typeDescriptor = builder.getTypeDescriptor();
    const pipeline = builder.build(setState, typeDescriptor);
    const getOutput = (): OutputType[] => extract(getState(), typeDescriptor);
    return [pipeline, getOutput];
}

export function simulateState<T>(initialState: T): [() => T, (transform: Transform<T>) => void] {
    let state: T = initialState;
    return [
        () => state,
        (transform: Transform<T>) => state = transform(state)
    ];
}

export function extract(state: KeyedArray<any>, typeDescriptor: TypeDescriptor): any[] {
    return state.map(item => extractItem(item, typeDescriptor));
}

function extractItem(item: { key: string; value: any; }, typeDescriptor: TypeDescriptor): any {
    const arrays: any = {};
    for (const arrayDescriptor of typeDescriptor.arrays) {
        const array = item.value[arrayDescriptor.name];
        arrays[arrayDescriptor.name] = array ? extract(array, arrayDescriptor.type) : [];
    }
    return { ...item.value, ...arrays };
}

