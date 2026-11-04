import type { KeyedArray, PipelinePlainOutputShape } from './builder.js';
import type { DescriptorNode, TypeDescriptor } from './pipeline.js';

/**
 * Converts keyed pipeline state to plain objects: each nested {@link KeyedArray}, in a row or in
 * an object property, becomes a plain array of row values, matching {@link PipelinePlainOutputShape}.
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
    // Object.fromEntries defines own properties, even one named `__proto__`.
    const arrays = Object.fromEntries(node.arrays.map(arrayDescriptor => [
        arrayDescriptor.name,
        extractKeyedArray((valueRecord[arrayDescriptor.name] as KeyedArray<object> | undefined) ?? [], arrayDescriptor.type)
    ]));
    return { ...valueRecord, ...arrays, ...extractObjects(valueRecord, node) } as PipelinePlainOutputShape<T>;
}

/**
 * The node's object properties, with the keyed arrays inside them made plain. An object holds
 * a copy of a row (`enrich`) or of a row's props (`pickByMin`, `pickByMax`): only the arrays it
 * carries are converted.
 */
function extractObjects(valueRecord: Record<string, unknown>, node: DescriptorNode): Record<string, unknown> {
    return Object.fromEntries(node.objects.flatMap(objectDescriptor => {
        const nested = valueRecord[objectDescriptor.name];
        return nested !== null && typeof nested === 'object'
            ? [[objectDescriptor.name, extractObject(nested as Record<string, unknown>, objectDescriptor.type)]]
            : [];
    }));
}

function extractObject(valueRecord: Record<string, unknown>, node: DescriptorNode): Record<string, unknown> {
    const arrays = Object.fromEntries(node.arrays.flatMap(arrayDescriptor => {
        const nested = valueRecord[arrayDescriptor.name];
        return Array.isArray(nested)
            ? [[arrayDescriptor.name, extractKeyedArray(nested as KeyedArray<object>, arrayDescriptor.type)]]
            : [];
    }));
    return { ...valueRecord, ...arrays, ...extractObjects(valueRecord, node) };
}
