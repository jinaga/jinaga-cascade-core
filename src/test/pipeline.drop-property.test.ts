import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline dropProperty', () => {
    it('should drop a property', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ a: number, b: number, c: string }>()
                .dropProperty("c")
        );

        pipeline.add("item1", { a: 2, b: 5, c: "test" });
        pipeline.add("item2", { a: 4, b: -1, c: "foo" });

        const output = getOutput();

        expect(output).toEqual([
            { a: 2, b: 5 },
            { a: 4, b: -1 }
        ]);
    });

    it('should remove an item after dropping a property', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ a: number, b: number, c: string }>()
                .dropProperty("c")
        );

        const item1 = { a: 2, b: 5, c: "test" };
        const item2 = { a: 4, b: -1, c: "foo" };
        const item3 = { a: 10, b: 20, c: "bar" };
        pipeline.add("item1", item1);
        pipeline.add("item2", item2);
        pipeline.add("item3", item3);

        expect(getOutput()).toEqual([
            { a: 2, b: 5 },
            { a: 4, b: -1 },
            { a: 10, b: 20 }
        ]);

        pipeline.remove("item2", item2);

        expect(getOutput()).toEqual([
            { a: 2, b: 5 },
            { a: 10, b: 20 }
        ]);
    });

    it('should only drop property at scoped level, not at nested levels', () => {
        // Create pipeline with property defined at both root and nested levels
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .defineProperty('computed', (group) => `Group: ${group.category}`)
                .in('items').defineProperty('computed', (item) => `Item: ${item.value}`)
                .in('items').dropProperty('computed')  // Drop at nested level - should only drop from items, not groups
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });

        const output = getOutput();
        expect(output.length).toBe(1);
        // Root level should still have computed property (not dropped)
        expect(output[0].computed).toBe('Group: A');
        // Nested level should not have computed property (dropped)
        expect(output[0].items[0] && 'computed' in output[0].items[0] ? (output[0].items[0] as { computed?: unknown }).computed : undefined).toBeUndefined();
        expect(output[0].items[1] && 'computed' in output[0].items[1] ? (output[0].items[1] as { computed?: unknown }).computed : undefined).toBeUndefined();
    });

    it('should drop an array property when the property is an array', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')  // dropProperty should detect this is an array and behave like dropArray
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput();
        expect(output.length).toBe(2);
        const outputTyped = output as Array<{ category: string; items?: unknown }>;
        
        const groupA = outputTyped.find(g => g.category === 'A');
        const groupB = outputTyped.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.items).toBeUndefined(); // Array should be dropped
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.items).toBeUndefined(); // Array should be dropped
    });

    it('should suppress events for dropped array property', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')  // Should suppress events at or below items array
        );

        // Add items before dropProperty (should still work)
        pipeline.add("item1", { category: 'A', value: 10 });
        
        const output1 = getOutput() as Array<{ category: string; items?: unknown }>;
        expect(output1.length).toBe(1);
        expect(output1[0].category).toBe('A');
        expect(output1[0].items).toBeUndefined();

        // Add more items after dropProperty - events should be suppressed
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });
        
        const output2 = getOutput() as Array<{ category: string; items?: unknown }>;
        expect(output2.length).toBe(2);
        // Items array should still be absent even after adding more items
        expect(output2[0].items).toBeUndefined();
        expect(output2[1].items).toBeUndefined();
    });

    describe('drop-property scalar handling', () => {
        it('should remove dropped scalar from scalars list', () => {
            interface Product {
                id: string;
                name: string;
                price: number;
            }

            const pipeline = createPipeline<Product, 'products'>('products', [
                { name: 'id', type: 'string' },
                { name: 'name', type: 'string' },
                { name: 'price', type: 'number' }
            ])
            .dropProperty('price');

            const descriptor = pipeline.getTypeDescriptor();
            expect(descriptor.scalars).toHaveLength(2);
            expect(descriptor.scalars.find(s => s.name === 'id')).toBeDefined();
            expect(descriptor.scalars.find(s => s.name === 'name')).toBeDefined();
            expect(descriptor.scalars.find(s => s.name === 'price')).toBeUndefined();
        });

        it('should preserve non-dropped scalars', () => {
            interface Order {
                orderId: string;
                customerId: string;
                amount: number;
                status: string;
            }

            const pipeline = createPipeline<Order, 'orders'>('orders', [
                { name: 'orderId', type: 'string' },
                { name: 'customerId', type: 'string' },
                { name: 'amount', type: 'number' },
                { name: 'status', type: 'string' }
            ])
            .dropProperty('status');

            const descriptor = pipeline.getTypeDescriptor();
            expect(descriptor.scalars).toHaveLength(3);
            expect(descriptor.scalars).toContainEqual({ name: 'orderId', type: 'string' });
            expect(descriptor.scalars).toContainEqual({ name: 'customerId', type: 'string' });
            expect(descriptor.scalars).toContainEqual({ name: 'amount', type: 'number' });
        });

        it('should handle dropping array properties without affecting scalars', () => {
            // This test ensures drop-property logic distinguishes scalars from arrays
            interface Order {
                id: string;
                items: Item[];
            }
            interface Item {
                itemId: string;
            }

            const pipeline = createPipeline<Order, 'orders'>('orders', [
                { name: 'id', type: 'string' }
            ])
            // Assume groupBy creates items array
            .dropProperty('items');

            const descriptor = pipeline.getTypeDescriptor();
            // Scalars should be unchanged
            expect(descriptor.scalars).toHaveLength(1);
            expect(descriptor.scalars[0]).toEqual({ name: 'id', type: 'string' });
        });
    });
});


