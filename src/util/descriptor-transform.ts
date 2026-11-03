import type { DescriptorNode, ObjectDescriptor, ScalarDescriptor } from '../pipeline.js';

/**
 * Canonical empty node: metadata lists are always present (never undefined).
 */
export function emptyDescriptorNode(): DescriptorNode {
    return {
        arrays: [],
        collectionKey: [],
        scalars: [],
        objects: [],
        mutableProperties: []
    };
}

export function filterMetadataByPropertyName(node: DescriptorNode, propertyName: string): DescriptorNode {
    return {
        ...node,
        mutableProperties: node.mutableProperties.filter(p => p !== propertyName),
        objects: node.objects.filter(o => o.name !== propertyName)
    };
}

export function appendObjectIfMissing(
    node: DescriptorNode,
    objectDesc: ObjectDescriptor
): DescriptorNode {
    if (node.objects.some(o => o.name === objectDesc.name)) {
        return node;
    }
    return {
        ...node,
        objects: [...node.objects, objectDesc]
    };
}

export function appendMutableIfMissing(node: DescriptorNode, propertyName: string): DescriptorNode {
    if (node.mutableProperties.includes(propertyName)) {
        return node;
    }
    return {
        ...node,
        mutableProperties: [...node.mutableProperties, propertyName]
    };
}

export function appendScalarIfMissing(node: DescriptorNode, scalar: ScalarDescriptor): DescriptorNode {
    if (node.scalars.some(s => s.name === scalar.name)) {
        return node;
    }
    return {
        ...node,
        scalars: [...node.scalars, scalar]
    };
}

/**
 * Replaces the node at `path` (array names from the root) with `update(node)`, keeping every
 * array's other metadata. A path that names a missing array changes nothing.
 */
export function updateNodeAt<T extends DescriptorNode>(
    node: T,
    path: readonly string[],
    update: (node: DescriptorNode) => DescriptorNode
): T {
    if (path.length === 0) {
        return { ...node, ...update(node) };
    }
    const [segment, ...rest] = path;
    return {
        ...node,
        arrays: node.arrays.map(array =>
            array.name === segment ? { ...array, type: updateNodeAt(array.type, rest, update) } : array
        )
    };
}

/**
 * Declares a numeric property that a step computes over the items at `segmentPath`: it
 * belongs to their parent level, and changes as the items do.
 */
export function appendAggregateAt<T extends DescriptorNode>(
    descriptor: T,
    segmentPath: readonly string[],
    propertyName: string
): T {
    return updateNodeAt(descriptor, segmentPath.slice(0, -1), node =>
        appendMutableIfMissing(appendScalarIfMissing(node, { name: propertyName, type: 'number' }), propertyName)
    );
}
