import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline groupBy', () => {
    it('should group by single key property', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'B', value: 20 });
        pipeline.add("item3", { category: 'A', value: 30 });

        const output = getOutput();
        expect(output.length).toBe(2);
        
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.items).toEqual([{ value: 10 }, { value: 30 }]);
        
        expect(groupB).toBeDefined();
        expect(groupB?.items).toEqual([{ value: 20 }]);
    });

    it('should group by multiple key properties', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, status: string, value: number }>()
                .groupBy(['category', 'status'], 'items')
        );

        pipeline.add("item1", { category: 'A', status: 'active', value: 10 });
        pipeline.add("item2", { category: 'A', status: 'inactive', value: 20 });
        pipeline.add("item3", { category: 'A', status: 'active', value: 30 });

        const output = getOutput();
        expect(output.length).toBe(2);
        
        const activeGroup = output.find(g => g.category === 'A' && g.status === 'active');
        const inactiveGroup = output.find(g => g.category === 'A' && g.status === 'inactive');
        
        expect(activeGroup).toBeDefined();
        expect(activeGroup?.items).toEqual([{ value: 10 }, { value: 30 }]);
        
        expect(inactiveGroup).toBeDefined();
        expect(inactiveGroup?.items).toEqual([{ value: 20 }]);
    });

    it('should handle multiple items in same group', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'A', value: 30 });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].category).toBe('A');
        expect(output[0].items).toEqual([
            { value: 10 },
            { value: 20 },
            { value: 30 }
        ]);
    });

    it('should handle items in different groups', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'B', value: 20 });
        pipeline.add("item3", { category: 'C', value: 30 });

        const output = getOutput();
        expect(output.length).toBe(3);
        
        expect(output.some(g => g.category === 'A' && g.items.length === 1)).toBe(true);
        expect(output.some(g => g.category === 'B' && g.items.length === 1)).toBe(true);
        expect(output.some(g => g.category === 'C' && g.items.length === 1)).toBe(true);
    });

    it('should remove items from groups', () => {
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

        pipeline.remove("item2", item2);

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].items).toEqual([
            { value: 10 },
            { value: 30 }
        ]);
    });

    it('should remove group when last item is removed', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        const item1 = { category: 'A', value: 10 };
        const item2 = { category: 'B', value: 20 };
        pipeline.add("item1", item1);
        pipeline.add("item2", item2);

        expect(getOutput().length).toBe(2);

        pipeline.remove("item1", item1);

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].category).toBe('B');
    });

    it('should work with computed properties before groupBy', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, a: number, b: number }>()
                .defineProperty("sum", (item) => item.a + item.b)
                .groupBy(['category'], 'items')
        );

        pipeline.add("item1", { category: 'A', a: 2, b: 5 });
        pipeline.add("item2", { category: 'A', a: 4, b: 1 });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].category).toBe('A');
        expect(output[0].items).toEqual([
            { a: 2, b: 5, sum: 7 },
            { a: 4, b: 1, sum: 5 }
        ]);
    });

});

describe('group-by scalar propagation', () => {
    it('should preserve grouping key scalars at root', () => {
        interface Order {
            customerId: string;
            orderId: string;
            amount: number;
        }

        const pipeline = createPipeline<Order, 'orders'>('orders', [
            { name: 'customerId', type: 'string' },
            { name: 'orderId', type: 'string' },
            { name: 'amount', type: 'number' }
        ])
        .groupBy(['customerId'], 'orders');

        const descriptor = pipeline.getTypeDescriptor();
        
        // Root should have customerId scalar
        expect(descriptor.scalars).toHaveLength(1);
        expect(descriptor.scalars[0]).toEqual({ name: 'customerId', type: 'string' });
        
        // Child array should have remaining scalars
        expect(descriptor.arrays).toHaveLength(1);
        const childArray = descriptor.arrays[0];
        expect(childArray.type.scalars).toHaveLength(2);
        expect(childArray.type.scalars).toContainEqual({ name: 'orderId', type: 'string' });
        expect(childArray.type.scalars).toContainEqual({ name: 'amount', type: 'number' });
    });

    it('should preserve scalar types in nested group-by', () => {
        interface Transaction {
            date: string;
            accountId: string;
            amount: number;
            isDebit: boolean;
        }

        const pipeline = createPipeline<Transaction, 'transactions'>('transactions', [
            { name: 'date', type: 'date' },
            { name: 'accountId', type: 'string' },
            { name: 'amount', type: 'number' },
            { name: 'isDebit', type: 'boolean' }
        ])
        .groupBy(['accountId'], 'transactions');

        const descriptor = pipeline.getTypeDescriptor();
        const childArray = descriptor.arrays[0];
        
        expect(childArray.type.scalars).toHaveLength(3);
        expect(childArray.type.scalars.find(s => s.name === 'date')?.type).toBe('date');
        expect(childArray.type.scalars.find(s => s.name === 'amount')?.type).toBe('number');
        expect(childArray.type.scalars.find(s => s.name === 'isDebit')?.type).toBe('boolean');
    });
});

