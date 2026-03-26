import type { KeyedArray, PipelinePlainOutputShape } from './builder.js';
import type { DescriptorNode, TypeDescriptor } from './pipeline.js';

/**
 * Converts keyed pipeline state to plain objects: each nested {@link KeyedArray} becomes a plain array
 * of row values, matching {@link PipelinePlainOutputShape}.
 *
 * Pass the descriptor from `getTypeDescriptor()` on the same builder used for `.build(...)`.
 */
export function toPipelinePlainOutput<T extends object>(
    state: KeyedArray<T>,
    descriptor: TypeDescriptor
): PipelinePlainOutputShape<T>[] {
    return state.map(item => extractRow(item, descriptor));
}

function extractKeyedArray<S extends object>(
    state: KeyedArray<S>,
    node: DescriptorNode
): PipelinePlainOutputShape<S>[] {
    return state.map(item => extractRow(item, node));
}

function extractRow<T extends object>(
    item: { key: string; value: T },
    node: DescriptorNode
): PipelinePlainOutputShape<T> {
    const valueRecord = item.value as Record<string, unknown>;
    const arrays: Record<string, unknown> = {};
    for (const arrayDescriptor of node.arrays) {
        const nested = valueRecord[arrayDescriptor.name];
        const keyed = nested as KeyedArray<object> | undefined;
        arrays[arrayDescriptor.name] = keyed ? extractKeyedArray(keyed, arrayDescriptor.type) : [];
    }
    return { ...valueRecord, ...arrays } as PipelinePlainOutputShape<T>;
}
