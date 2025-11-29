import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pickByMin', () => {
    describe('basic functionality', () => {
        it('should pick object with minimum numeric property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            pipeline.add('item2', { category: 'Electronics', itemName: 'Laptop', price: 1200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'Electronics');
            expect(group?.cheapestItem).toEqual({ itemName: 'Phone', price: 500 });
        });

        it('should pick object with minimum string property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'name', 'firstItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Zebra', name: 'Zebra' });
            pipeline.add('item2', { category: 'A', itemName: 'Apple', name: 'Apple' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.firstItem).toEqual({ itemName: 'Apple', name: 'Apple' });
        });

        it('should return undefined for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            const item1 = { category: 'A', price: 100 };
            pipeline.add('item1', item1);
            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output.length).toBe(0);
        });

        it('should ignore null/undefined values in comparison', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number | null | undefined }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: undefined });
            pipeline.add('item3', { category: 'A', price: 50 });
            pipeline.add('item4', { category: 'A', price: 100 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem).toEqual({ price: 50 });
        });
    });

    describe('numeric comparison', () => {
        it('should handle numeric comparison correctly', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: 50 });
            pipeline.add('item3', { category: 'A', price: 200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);
        });

        it('should handle negative numbers', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; value: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'value', 'minItem')
            );

            pipeline.add('item1', { category: 'A', value: -10 });
            pipeline.add('item2', { category: 'A', value: -5 });
            pipeline.add('item3', { category: 'A', value: 0 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.minItem?.value).toBe(-10);
        });

        it('should handle zero values', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: 0 });
            pipeline.add('item2', { category: 'A', price: 100 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(0);
        });

        it('should handle decimal numbers', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: 10.5 });
            pipeline.add('item2', { category: 'A', price: 10.1 });
            pipeline.add('item3', { category: 'A', price: 10.9 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(10.1);
        });
    });

    describe('string comparison', () => {
        it('should handle lexicographic string comparison', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'name', 'firstItem')
            );

            pipeline.add('item1', { category: 'A', name: 'Zebra' });
            pipeline.add('item2', { category: 'A', name: 'Apple' });
            pipeline.add('item3', { category: 'A', name: 'Banana' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.firstItem?.name).toBe('Apple');
        });

        it('should handle empty strings', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'name', 'firstItem')
            );

            pipeline.add('item1', { category: 'A', name: 'Zebra' });
            pipeline.add('item2', { category: 'A', name: '' });
            pipeline.add('item3', { category: 'A', name: 'Apple' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.firstItem?.name).toBe('');
        });

        it('should handle case-sensitive comparison', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'name', 'firstItem')
            );

            pipeline.add('item1', { category: 'A', name: 'apple' });
            pipeline.add('item2', { category: 'A', name: 'Apple' });
            pipeline.add('item3', { category: 'A', name: 'BANANA' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            // 'Apple' < 'BANANA' < 'apple' in ASCII
            expect(group?.firstItem?.name).toBe('Apple');
        });
    });

    describe('incremental updates', () => {
        it('should update when new minimum is added', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(100);

            pipeline.add('item2', { category: 'A', price: 50 });
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);
        });

        it('should update when current minimum is removed', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 50 };
            const item3 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);

            pipeline.remove('item2', item2); // Remove the minimum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(100); // New minimum
        });

        it('should handle removal by recalculating from remaining items', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 50 };
            const item3 = { category: 'A', price: 75 };
            const item4 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);
            pipeline.add('item4', item4);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);

            pipeline.remove('item2', item2); // Remove minimum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(75); // Recalculated minimum
        });

        it('should maintain correct minimum when non-minimum items are removed', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 50 };
            const item3 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);

            pipeline.remove('item3', item3); // Remove non-minimum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50); // Minimum unchanged
        });
    });

    describe('edge cases', () => {
        it('should handle ties by picking first encountered', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: 100, name: 'First' });
            pipeline.add('item2', { category: 'A', price: 100, name: 'Second' });
            pipeline.add('item3', { category: 'A', price: 100, name: 'Third' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.name).toBe('First'); // First encountered wins
        });

        it('should handle all null/undefined values', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number | null | undefined }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: undefined });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem).toBeUndefined();
        });

        it('should handle mixed null and valid values', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number | null | undefined }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: 50 });
            pipeline.add('item3', { category: 'A', price: undefined });
            pipeline.add('item4', { category: 'A', price: 100 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.cheapestItem?.price).toBe(50);
        });
    });

    describe('scoped usage', () => {
        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .pickByMin('venues', 'capacity', 'smallestVenue')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.smallestVenue?.capacity).toBe(20000);
        });

        it('should work with nested arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; subcategory: string; itemName: string; price: number }>()
                    .groupBy(['category', 'subcategory'], 'items')
                    .groupBy(['category'], 'subcategories')
                    .in('subcategories')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'Electronics', subcategory: 'Phones', itemName: 'Phone1', price: 500 });
            pipeline.add('item2', { category: 'Electronics', subcategory: 'Phones', itemName: 'Phone2', price: 300 });

            const output = getOutput();
            const category = output.find(c => c.category === 'Electronics');
            const subcategory = category?.subcategories.find(s => s.subcategory === 'Phones');
            expect(subcategory?.cheapestItem?.price).toBe(300);
        });
    });

    describe('integration', () => {
        it('should work with groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Item1', price: 100 });
            pipeline.add('item2', { category: 'A', itemName: 'Item2', price: 50 });
            pipeline.add('item3', { category: 'B', itemName: 'Item3', price: 75 });

            const output = getOutput();
            const groupA = output.find(g => g.category === 'A');
            const groupB = output.find(g => g.category === 'B');
            expect(groupA?.cheapestItem?.price).toBe(50);
            expect(groupB?.cheapestItem?.price).toBe(75);
        });

        it('should keep the array in the output (like other aggregate functions)', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Item1', price: 100 });
            pipeline.add('item2', { category: 'A', itemName: 'Item2', price: 50 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            
            // Verify the array is still present
            expect(group?.items).toBeDefined();
            expect(group?.items).toHaveLength(2);
            expect(group?.items[0]).toEqual({ itemName: 'Item1', price: 100 });
            expect(group?.items[1]).toEqual({ itemName: 'Item2', price: 50 });
            
            // Verify the picked object is also present
            expect(group?.cheapestItem).toBeDefined();
            expect(group?.cheapestItem?.price).toBe(50);
        });

        it('should allow chaining with dropProperty to remove the array', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
                    .dropProperty('items')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Item1', price: 100 });
            pipeline.add('item2', { category: 'A', itemName: 'Item2', price: 50 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            
            // Verify the array is removed (use 'as any' since dropProperty removes it from type)
            expect((group as any)?.items).toBeUndefined();
            
            // Verify the picked object is still present
            expect(group?.cheapestItem).toBeDefined();
            expect(group?.cheapestItem?.price).toBe(50);
        });

        it('should work with other pipeline steps', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMin('items', 'price', 'cheapestItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Item1', price: 50 });
            pipeline.add('item2', { category: 'A', itemName: 'Item2', price: 150 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            // Verify that pickByMin works correctly with groupBy
            expect(group?.cheapestItem).toBeDefined();
            expect(group?.cheapestItem?.price).toBe(50);
            expect(group?.cheapestItem?.itemName).toBe('Item1');
        });
    });

    describe('pickByMax', () => {
        it('should pick object with maximum numeric property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            pipeline.add('item2', { category: 'Electronics', itemName: 'Laptop', price: 1200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'Electronics');
            expect(group?.mostExpensiveItem).toEqual({ itemName: 'Laptop', price: 1200 });
        });

        it('should pick object with maximum string property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'name', 'lastItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Apple', name: 'Apple' });
            pipeline.add('item2', { category: 'A', itemName: 'Zebra', name: 'Zebra' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.lastItem).toEqual({ itemName: 'Zebra', name: 'Zebra' });
        });

        it('should return undefined for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            const item1 = { category: 'A', price: 100 };
            pipeline.add('item1', item1);
            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output.length).toBe(0);
        });

        it('should update when new maximum is added', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.mostExpensiveItem?.price).toBe(100);

            pipeline.add('item2', { category: 'A', price: 200 });
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.mostExpensiveItem?.price).toBe(200);
        });

        it('should update when current maximum is removed', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 200 };
            const item3 = { category: 'A', price: 50 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.mostExpensiveItem?.price).toBe(200);

            pipeline.remove('item2', item2); // Remove the maximum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.mostExpensiveItem?.price).toBe(100); // New maximum
        });

        it('should handle ties by picking first encountered', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number; name: string }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            pipeline.add('item1', { category: 'A', price: 100, name: 'First' });
            pipeline.add('item2', { category: 'A', price: 100, name: 'Second' });
            pipeline.add('item3', { category: 'A', price: 100, name: 'Third' });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.mostExpensiveItem?.name).toBe('First'); // First encountered wins
        });

        it('should keep the array in the output (like other aggregate functions)', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .pickByMax('items', 'price', 'mostExpensiveItem')
            );

            pipeline.add('item1', { category: 'A', itemName: 'Item1', price: 100 });
            pipeline.add('item2', { category: 'A', itemName: 'Item2', price: 200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            
            // Verify the array is still present
            expect(group?.items).toBeDefined();
            expect(group?.items).toHaveLength(2);
            
            // Verify the picked object is also present
            expect(group?.mostExpensiveItem).toBeDefined();
            expect(group?.mostExpensiveItem?.price).toBe(200);
        });
    });
});

