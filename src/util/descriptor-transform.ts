import type { DescriptorNode, ObjectDescriptor } from '../pipeline.js';

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
