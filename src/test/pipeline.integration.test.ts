import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline integration tests', () => {
    it('should handle nested arrays with defineProperty step on groups', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .defineProperty('groupLabel', (group) => `Group: ${group.category}`)
                .in('items').defineProperty('itemLabel', (item) => `Item: ${item.value}`)
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].category).toBe('A');
        expect((output[0] as { groupLabel?: string }).groupLabel).toBe('Group: A');
        // Items should NOT have groupLabel, but should have itemLabel
        expect(output[0].items).toEqual([
            { value: 10, itemLabel: 'Item: 10' },
            { value: 20, itemLabel: 'Item: 20' }
        ]);
    });

    it('should handle nested arrays with dropProperty step', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number, extra: string }>()
                .groupBy(['category'], 'items')
                .in('items').dropProperty('extra')
        );

        pipeline.add("item1", { category: 'A', value: 10, extra: 'x' });
        pipeline.add("item2", { category: 'A', value: 20, extra: 'y' });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].category).toBe('A');
        expect(output[0].items).toEqual([
            { value: 10 },
            { value: 20 }
        ]);
    });

    it('should maintain separate state for groups and items in nested arrays', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'B', value: 20 });
        pipeline.add("item3", { category: 'A', value: 30 });

        const output = getOutput();
        // Should have 2 groups
        expect(output.length).toBe(2);
        
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.items).toEqual([{ value: 10 }, { value: 30 }]);
        
        expect(groupB).toBeDefined();
        expect(groupB?.items).toEqual([{ value: 20 }]);
    });

    it('should correctly remove items from nested arrays', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        const item1 = { category: 'A', value: 10 };
        const item2 = { category: 'A', value: 20 };
        const item3 = { category: 'A', value: 30 };
        pipeline.add("item1", item1);
        pipeline.add("item2", item2);
        pipeline.add("item3", item3);

        expect(getOutput()[0].items.length).toBe(3);

        // Remove using original item key
        pipeline.remove("item2", item2);

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].items).toEqual([
            { value: 10 },
            { value: 30 }
        ]);
    });
});


