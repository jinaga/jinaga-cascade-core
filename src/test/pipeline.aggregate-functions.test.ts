import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('Aggregate Functions', () => {
    describe('sum', () => {
        it('should sum numeric property over array', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalPrice')
            );

            pipeline.add('item1', { category: 'Electronics', itemName: 'Phone', price: 500 });
            pipeline.add('item2', { category: 'Electronics', itemName: 'Laptop', price: 1200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'Electronics');
            expect(group?.totalPrice).toBe(1700);
        });

        it('should handle null/undefined by treating as 0', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number | null | undefined }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalPrice')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: null });
            pipeline.add('item3', { category: 'A', price: undefined });
            pipeline.add('item4', { category: 'A', price: 50 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.totalPrice).toBe(150); // 100 + 0 + 0 + 50
        });

        it('should return 0 for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalPrice')
            );

            const item1 = { category: 'A', price: 100 };
            pipeline.add('item1', item1);
            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output.length).toBe(0);
        });

        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .sum('venues', 'capacity', 'totalCapacity')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(70000);
        });

        it('should handle removal correctly', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalPrice')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 200 };
            const item3 = { category: 'A', price: 300 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.totalPrice).toBe(600);

            pipeline.remove('item2', item2);

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.totalPrice).toBe(400);
        });
    });

    describe('count', () => {
        it('should count items in array', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string }>()
                    .groupBy(['category'], 'items')
                    .count('items', 'itemCount')
            );

            pipeline.add('item1', { category: 'Electronics', itemName: 'Phone' });
            pipeline.add('item2', { category: 'Electronics', itemName: 'Laptop' });
            pipeline.add('item3', { category: 'Electronics', itemName: 'Tablet' });

            const output = getOutput();
            const group = output.find(g => g.category === 'Electronics');
            expect(group?.itemCount).toBe(3);
        });

        it('should return 0 for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string }>()
                    .groupBy(['category'], 'items')
                    .count('items', 'itemCount')
            );

            const item1 = { category: 'A', itemName: 'Item' };
            pipeline.add('item1', item1);
            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output.length).toBe(0);
        });

        it('should increment/decrement correctly on add/remove', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; itemName: string }>()
                    .groupBy(['category'], 'items')
                    .count('items', 'itemCount')
            );

            const item1 = { category: 'A', itemName: 'Item1' };
            const item2 = { category: 'A', itemName: 'Item2' };
            pipeline.add('item1', item1);
            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.itemCount).toBe(1);

            pipeline.add('item2', item2);
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.itemCount).toBe(2);

            pipeline.remove('item1', item1);
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.itemCount).toBe(1);
        });

        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .count('venues', 'venueCount')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium' });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena' });
            pipeline.add('v3', { state: 'TX', city: 'Houston', venue: 'Center' });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            const houstonCity = txState?.cities.find(c => c.city === 'Houston');
            expect(dallasCity?.venueCount).toBe(2);
            expect(houstonCity?.venueCount).toBe(1);
        });
    });

    describe('min', () => {
        it('should find minimum value of property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .min('items', 'price', 'minPrice')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: 50 });
            pipeline.add('item3', { category: 'A', price: 200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.minPrice).toBe(50);
        });

        it('should return undefined for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .min('items', 'price', 'minPrice')
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
                    .min('items', 'price', 'minPrice')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: undefined });
            pipeline.add('item3', { category: 'A', price: 50 });
            pipeline.add('item4', { category: 'A', price: 100 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.minPrice).toBe(50);
        });

        it('should handle removal by tracking all values', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .min('items', 'price', 'minPrice')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 50 };
            const item3 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.minPrice).toBe(50);

            pipeline.remove('item2', item2); // Remove the minimum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.minPrice).toBe(100); // New minimum
        });

        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .min('venues', 'capacity', 'minCapacity')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.minCapacity).toBe(20000);
        });
    });

    describe('max', () => {
        it('should find maximum value of property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .max('items', 'price', 'maxPrice')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: 50 });
            pipeline.add('item3', { category: 'A', price: 200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.maxPrice).toBe(200);
        });

        it('should return undefined for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .max('items', 'price', 'maxPrice')
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
                    .max('items', 'price', 'maxPrice')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: undefined });
            pipeline.add('item3', { category: 'A', price: 50 });
            pipeline.add('item4', { category: 'A', price: 100 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.maxPrice).toBe(100);
        });

        it('should handle removal by tracking all values', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .max('items', 'price', 'maxPrice')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 50 };
            const item3 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.maxPrice).toBe(200);

            pipeline.remove('item3', item3); // Remove the maximum

            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.maxPrice).toBe(100); // New maximum
        });

        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .max('venues', 'capacity', 'maxCapacity')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.maxCapacity).toBe(50000);
        });
    });

    describe('average', () => {
        it('should compute average of numeric property', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .average('items', 'price', 'avgPrice')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: 200 });
            pipeline.add('item3', { category: 'A', price: 300 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.avgPrice).toBe(200); // (100 + 200 + 300) / 3
        });

        it('should return undefined for empty arrays', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .average('items', 'price', 'avgPrice')
            );

            const item1 = { category: 'A', price: 100 };
            pipeline.add('item1', item1);
            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output.length).toBe(0);
        });

        it('should track sum and count separately for incremental updates', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .average('items', 'price', 'avgPrice')
            );

            const item1 = { category: 'A', price: 100 };
            const item2 = { category: 'A', price: 200 };
            pipeline.add('item1', item1);
            let output = getOutput();
            let group = output.find(g => g.category === 'A');
            expect(group?.avgPrice).toBe(100);

            pipeline.add('item2', item2);
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.avgPrice).toBe(150); // (100 + 200) / 2

            pipeline.remove('item1', item1);
            output = getOutput();
            group = output.find(g => g.category === 'A');
            expect(group?.avgPrice).toBe(200); // 200 / 1
        });

        it('should handle null/undefined by excluding from both sum and count', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number | null | undefined }>()
                    .groupBy(['category'], 'items')
                    .average('items', 'price', 'avgPrice')
            );

            pipeline.add('item1', { category: 'A', price: null });
            pipeline.add('item2', { category: 'A', price: undefined });
            pipeline.add('item3', { category: 'A', price: 100 });
            pipeline.add('item4', { category: 'A', price: 200 });

            const output = getOutput();
            const group = output.find(g => g.category === 'A');
            expect(group?.avgPrice).toBe(150); // (100 + 200) / 2, null/undefined excluded
        });

        it('should support scoped usage via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities')
                    .average('venues', 'capacity', 'avgCapacity')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.avgCapacity).toBe(35000); // (50000 + 20000) / 2
        });
    });

    describe('integration with other steps', () => {
        it('should work with dropProperty', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; price: number }>()
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalPrice')
                    .dropProperty('items')
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'A', price: 200 });

            const output = getOutput() as Array<{ category: string; totalPrice: number; items?: unknown }>;
            const group = output.find(g => g.category === 'A');
            expect(group?.totalPrice).toBe(300);
            expect(group?.items).toBeUndefined();
        });

        it('should work with nested paths', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ state: string; city: string; venue: string; capacity: number }>()
                    .groupBy(['state', 'city'], 'venues')
                    .groupBy(['state'], 'cities')
                    .in('cities').sum('venues', 'capacity', 'totalCapacity')
            );

            pipeline.add('v1', { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add('v2', { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const txState = output.find(s => s.state === 'TX');
            const dallasCity = (txState?.cities as Array<{ city: string; totalCapacity: number }> | undefined)?.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(70000);
        });
    });
});
