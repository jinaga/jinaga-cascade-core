import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline filter', () => {
    describe('basic functionality', () => {
        it('should include items matching predicate', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; price: number }>()
                    .filter(item => item.price > 50)
            );

            pipeline.add('item1', { category: 'A', price: 100 });
            pipeline.add('item2', { category: 'B', price: 25 });
            pipeline.add('item3', { category: 'C', price: 75 });

            const output = getOutput();

            expect(output).toHaveLength(2);
            expect(output).toContainEqual({ category: 'A', price: 100 });
            expect(output).toContainEqual({ category: 'C', price: 75 });
        });

        it('should exclude items not matching predicate', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ status: string; value: number }>()
                    .filter(item => item.status === 'active')
            );

            pipeline.add('item1', { status: 'active', value: 100 });
            pipeline.add('item2', { status: 'inactive', value: 200 });
            pipeline.add('item3', { status: 'pending', value: 300 });

            const output = getOutput();

            expect(output).toHaveLength(1);
            expect(output[0]).toEqual({ status: 'active', value: 100 });
        });

        it('should handle empty input', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ value: number }>()
                    .filter(item => item.value > 0)
            );

            const output = getOutput();

            expect(output).toHaveLength(0);
        });

        it('should handle all items matching', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ value: number }>()
                    .filter(item => item.value > 0)
            );

            pipeline.add('item1', { value: 10 });
            pipeline.add('item2', { value: 20 });
            pipeline.add('item3', { value: 30 });

            const output = getOutput();

            expect(output).toHaveLength(3);
        });

        it('should preserve item properties unchanged', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ name: string; value: number; active: boolean }>()
                    .filter(item => item.active)
            );

            pipeline.add('item1', { name: 'Alice', value: 100, active: true });

            const output = getOutput();

            expect(output).toHaveLength(1);
            expect(output[0]).toEqual({ name: 'Alice', value: 100, active: true });
        });
    });

    describe('item removal', () => {
        it('should handle removal of matched item', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ status: string; value: number }>()
                    .filter(item => item.status === 'active')
            );

            const item1 = { status: 'active', value: 100 };
            const item2 = { status: 'active', value: 200 };

            pipeline.add('item1', item1);
            pipeline.add('item2', item2);

            expect(getOutput()).toHaveLength(2);

            pipeline.remove('item1', item1);

            const output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0]).toEqual({ status: 'active', value: 200 });
        });

        it('should ignore removal of filtered-out item', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ status: string; value: number }>()
                    .filter(item => item.status === 'active')
            );

            const item1 = { status: 'active', value: 100 };
            const item2 = { status: 'inactive', value: 200 };

            pipeline.add('item1', item1);
            pipeline.add('item2', item2);

            expect(getOutput()).toHaveLength(1);

            // Remove the filtered-out item - should be a no-op
            pipeline.remove('item2', item2);

            const output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0]).toEqual({ status: 'active', value: 100 });
        });

        it('should maintain correct state with multiple add/remove', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ status: string; value: number }>()
                    .filter(item => item.status === 'active')
            );

            const item1 = { status: 'active', value: 100 };
            const item2 = { status: 'inactive', value: 200 };
            const item3 = { status: 'active', value: 300 };

            pipeline.add('item1', item1);
            pipeline.add('item2', item2);
            pipeline.add('item3', item3);

            expect(getOutput()).toHaveLength(2);

            pipeline.remove('item1', item1);
            expect(getOutput()).toHaveLength(1);

            pipeline.remove('item2', item2);
            expect(getOutput()).toHaveLength(1);

            pipeline.remove('item3', item3);
            expect(getOutput()).toHaveLength(0);
        });
    });

    describe('integration with groupBy', () => {
        it('should filter before groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; price: number; inStock: boolean }>()
                    .filter(item => item.inStock)
                    .groupBy(['category'], 'items')
            );

            pipeline.add('p1', { category: 'Electronics', price: 500, inStock: true });
            pipeline.add('p2', { category: 'Electronics', price: 300, inStock: false });
            pipeline.add('p3', { category: 'Electronics', price: 200, inStock: true });

            const output = getOutput();

            expect(output).toHaveLength(1);
            const group = output.find(g => g.category === 'Electronics');
            expect(group).toBeDefined();
            expect(group?.items).toHaveLength(2);
            expect(group?.items).toContainEqual({ price: 500, inStock: true });
            expect(group?.items).toContainEqual({ price: 200, inStock: true });
        });

        it('should filter after groupBy with in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ department: string; employee: string; salary: number }>()
                    .groupBy(['department'], 'employees')
                    .in('employees').filter(emp => emp.salary >= 50000)
            );

            pipeline.add('e1', { department: 'Engineering', employee: 'Alice', salary: 80000 });
            pipeline.add('e2', { department: 'Engineering', employee: 'Bob', salary: 45000 });
            pipeline.add('e3', { department: 'Engineering', employee: 'Carol', salary: 75000 });

            const output = getOutput();

            expect(output).toHaveLength(1);
            const group = output.find(g => g.department === 'Engineering');
            expect(group).toBeDefined();
            // Bob should be filtered out (salary < 50000)
            expect(group?.employees).toHaveLength(2);
            expect(group?.employees).toContainEqual({ employee: 'Alice', salary: 80000 });
            expect(group?.employees).toContainEqual({ employee: 'Carol', salary: 75000 });
        });
    });

    describe('integration with aggregates', () => {
        it('should filter before sum aggregate', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; price: number; inStock: boolean }>()
                    .filter(item => item.inStock)
                    .groupBy(['category'], 'items')
                    .sum('items', 'price', 'totalInStock')
            );

            pipeline.add('p1', { category: 'Electronics', price: 500, inStock: true });
            pipeline.add('p2', { category: 'Electronics', price: 300, inStock: false });
            pipeline.add('p3', { category: 'Electronics', price: 200, inStock: true });

            const output = getOutput();

            expect(output).toHaveLength(1);
            const group = output.find(g => g.category === 'Electronics');
            // Only in-stock items: 500 + 200 = 700
            expect(group?.totalInStock).toBe(700);
        });

        it('should filter before count aggregate', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; name: string; active: boolean }>()
                    .filter(item => item.active)
                    .groupBy(['category'], 'items')
                    .count('items', 'activeCount')
            );

            pipeline.add('i1', { category: 'A', name: 'Item1', active: true });
            pipeline.add('i2', { category: 'A', name: 'Item2', active: false });
            pipeline.add('i3', { category: 'A', name: 'Item3', active: true });
            pipeline.add('i4', { category: 'A', name: 'Item4', active: false });

            const output = getOutput();

            expect(output).toHaveLength(1);
            const group = output.find(g => g.category === 'A');
            // Only active items: 2
            expect(group?.activeCount).toBe(2);
        });
    });

    describe('chaining', () => {
        it('should chain multiple filters', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ type: string; amount: number; verified: boolean }>()
                    .filter(item => item.verified)
                    .filter(item => item.amount > 0)
            );

            pipeline.add('t1', { type: 'credit', amount: 100, verified: true });
            pipeline.add('t2', { type: 'credit', amount: -50, verified: true });
            pipeline.add('t3', { type: 'debit', amount: 200, verified: false });
            pipeline.add('t4', { type: 'credit', amount: 150, verified: true });

            const output = getOutput();

            // Only verified with positive amounts: t1 and t4
            expect(output).toHaveLength(2);
            expect(output).toContainEqual({ type: 'credit', amount: 100, verified: true });
            expect(output).toContainEqual({ type: 'credit', amount: 150, verified: true });
        });

        it('should combine with defineProperty', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ a: number; b: number }>()
                    .defineProperty('sum', item => item.a + item.b)
                    .filter(item => item.sum > 10)
            );

            pipeline.add('item1', { a: 5, b: 3 });   // sum = 8, filtered out
            pipeline.add('item2', { a: 8, b: 7 });   // sum = 15, included
            pipeline.add('item3', { a: 6, b: 6 });   // sum = 12, included

            const output = getOutput();

            expect(output).toHaveLength(2);
            expect(output).toContainEqual({ a: 8, b: 7, sum: 15 });
            expect(output).toContainEqual({ a: 6, b: 6, sum: 12 });
        });

        it('should combine with dropProperty', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; secret: string; value: number }>()
                    .filter(item => item.value > 50)
                    .dropProperty('secret')
            );

            pipeline.add('item1', { category: 'A', secret: 'xyz', value: 100 });
            pipeline.add('item2', { category: 'B', secret: 'abc', value: 25 });

            const output = getOutput() as Array<{ category: string; value: number; secret?: unknown }>;

            expect(output).toHaveLength(1);
            expect(output[0].category).toBe('A');
            expect(output[0].value).toBe(100);
            expect(output[0].secret).toBeUndefined();
        });
    });

    describe('scoped filtering', () => {
        it('should filter at root level (empty scope)', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ value: number }>()
                    .filter(item => item.value > 100)
            );

            pipeline.add('item1', { value: 50 });
            pipeline.add('item2', { value: 150 });
            pipeline.add('item3', { value: 200 });

            const output = getOutput();

            expect(output).toHaveLength(2);
            expect(output).toContainEqual({ value: 150 });
            expect(output).toContainEqual({ value: 200 });
        });

        it('should filter at first nesting level via in()', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ region: string; city: string; population: number }>()
                    .groupBy(['region'], 'cities')
                    .in('cities').filter(city => city.population > 100000)
            );

            pipeline.add('c1', { region: 'West', city: 'Los Angeles', population: 4000000 });
            pipeline.add('c2', { region: 'West', city: 'SmallTown', population: 5000 });
            pipeline.add('c3', { region: 'West', city: 'San Francisco', population: 900000 });

            const output = getOutput();

            expect(output).toHaveLength(1);
            const westRegion = output.find(r => r.region === 'West');
            expect(westRegion).toBeDefined();
            // SmallTown should be filtered out
            expect(westRegion?.cities).toHaveLength(2);
            expect(westRegion?.cities).toContainEqual({ city: 'Los Angeles', population: 4000000 });
            expect(westRegion?.cities).toContainEqual({ city: 'San Francisco', population: 900000 });
        });
    });
});