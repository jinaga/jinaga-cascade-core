import { createPipeline } from '../index';

describe('pipeline collection key metadata', () => {
    it('groupBy sets collection key to selected grouping properties', () => {
        const descriptor = createPipeline<{ category: string; region: string; amount: number }>()
            .groupBy(['category', 'region'], 'groups')
            .getTypeDescriptor();

        expect(descriptor.collectionKey).toEqual(['category', 'region']);
    });

    it('dropProperty clears key when dropping a key member', () => {
        const descriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .dropProperty('category')
            .getTypeDescriptor();

        expect(descriptor.collectionKey).toEqual([]);
    });

    it('dropProperty clears entire composite key when dropping one key member', () => {
        const categoryDroppedDescriptor = createPipeline<{ category: string; region: string; amount: number }>()
            .groupBy(['category', 'region'], 'groups')
            .dropProperty('category')
            .getTypeDescriptor();

        const regionDroppedDescriptor = createPipeline<{ category: string; region: string; amount: number }>()
            .groupBy(['category', 'region'], 'groups')
            .dropProperty('region')
            .getTypeDescriptor();

        expect(categoryDroppedDescriptor.collectionKey).toEqual([]);
        expect(regionDroppedDescriptor.collectionKey).toEqual([]);
    });

    it('dropProperty preserves key when dropping a non-key member', () => {
        const descriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .dropProperty('groups')
            .getTypeDescriptor();

        expect(descriptor.collectionKey).toEqual(['category']);
    });

    it('filter, aggregate and pick steps preserve collection key', () => {
        const groupedDescriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .getTypeDescriptor();

        const filteredDescriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .filter(group => group.category.length > 0)
            .getTypeDescriptor();

        const aggregatedDescriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .sum('groups', 'amount', 'totalAmount')
            .getTypeDescriptor();

        const pickedDescriptor = createPipeline<{ category: string; amount: number }>()
            .groupBy(['category'], 'groups')
            .pickByMax('groups', 'amount', 'largestItem')
            .getTypeDescriptor();

        expect(filteredDescriptor.collectionKey).toEqual(groupedDescriptor.collectionKey);
        expect(aggregatedDescriptor.collectionKey).toEqual(groupedDescriptor.collectionKey);
        expect(pickedDescriptor.collectionKey).toEqual(groupedDescriptor.collectionKey);
    });
});
