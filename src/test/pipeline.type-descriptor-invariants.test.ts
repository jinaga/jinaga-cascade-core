import { createPipeline } from '../index';
import type { DescriptorNode, TypeDescriptor } from '../pipeline';

function assertTotalMetadataArrays(node: DescriptorNode): void {
    expect(node.objects).toBeDefined();
    expect(node.mutableProperties).toBeDefined();
    expect(Array.isArray(node.objects)).toBe(true);
    expect(Array.isArray(node.mutableProperties)).toBe(true);
    for (const arrayDesc of node.arrays) {
        walkDescriptor(arrayDesc.type);
    }
    for (const objectDesc of node.objects) {
        walkDescriptor(objectDesc.type);
    }
}

function walkDescriptor(descriptor: TypeDescriptor | DescriptorNode): void {
    assertTotalMetadataArrays(descriptor);
}

describe('Type descriptor canonical metadata', () => {
    it('createPipeline root descriptor has objects and mutableProperties arrays', () => {
        const pipeline = createPipeline('items', [{ name: 'id', type: 'string' }]);
        walkDescriptor(pipeline.getTypeDescriptor());
    });

    it('groupBy preserves total metadata arrays at every node', () => {
        const pipeline = createPipeline<{ category: string; value: number }>()
            .groupBy(['category'], 'items');
        walkDescriptor(pipeline.getTypeDescriptor());
    });

    it('pickByMax then dropProperty leaves no stale object name and keeps total arrays', () => {
        const pipeline = createPipeline<{
            attendeePublicKey: string;
            createdAt: string;
            a0: number;
        }, 'allocations'>('allocations')
            .groupBy(['attendeePublicKey'], 'attendees')
            .pickByMax('allocations', 'createdAt', 'latestAllocation')
            .dropProperty('latestAllocation');

        const descriptor = pipeline.getTypeDescriptor();
        walkDescriptor(descriptor);
        expect(descriptor.objects.some(o => o.name === 'latestAllocation')).toBe(false);
    });

    it('groupBy then pickByMax keeps total metadata arrays on every node', () => {
        const pipeline = createPipeline<{
            attendeePublicKey: string;
            createdAt: string;
            a0: number;
        }, 'allocations'>('allocations')
            .groupBy(['attendeePublicKey'], 'attendees')
            .pickByMax('allocations', 'createdAt', 'latestAllocation');

        walkDescriptor(pipeline.getTypeDescriptor());
        const descriptor = pipeline.getTypeDescriptor();
        expect(descriptor.objects.some(o => o.name === 'latestAllocation')).toBe(true);
    });
});
