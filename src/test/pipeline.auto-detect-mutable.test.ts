import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

/**
 * Tests for auto-detection of mutable properties in CommutativeAggregate.
 * 
 * Currently, when sum() aggregates over a property that is itself mutable
 * (e.g., computed by defineProperty or another sum), the caller must
 * manually specify mutableProperties to track changes.
 * 
 * Example (current behavior):
 *   .sum('products', 'adjustedTotal', 'categoryTotal', ['adjustedTotal'])
 * 
 * Goal (auto-detection):
 *   .sum('products', 'adjustedTotal', 'categoryTotal')  // auto-detects from TypeDescriptor
 * 
 * These tests should FAIL until auto-detection is implemented.
 */
describe('CommutativeAggregate auto-detection of mutable properties', () => {
    
    describe('sum over computed mutable property', () => {
        it('should auto-update sum when aggregating over a computed mutable property (without manual mutableProperties)', () => {
            // Setup: Create pipeline that sums a computed property WITHOUT specifying mutableProperties
            //
            // Structure:
            // - Products grouped by category
            // - Each product has orders grouped by productId
            // - Sum orders.amount -> productTotal (mutable)
            // - Define adjustedTotal = productTotal * multiplier (mutable because depends on productTotal)
            // - Sum adjustedTotal at category level WITHOUT specifying ['adjustedTotal']
            //
            // The test: When productTotal changes (via new order), adjustedTotal changes,
            // and categoryTotal should auto-update because adjustedTotal is marked mutable in TypeDescriptor

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    // Define adjustedTotal that depends on mutable productTotal
                    // Markup of 10% if productTotal > 100
                    .in('products').defineProperty('adjustedTotal', item =>
                        item.productTotal > 100 ? item.productTotal * 1.1 : item.productTotal,
                        ['productTotal']
                    )
                    // KEY: Sum adjustedTotal WITHOUT specifying mutableProperties
                    // This should auto-detect that adjustedTotal is mutable
                    .sum('products', 'adjustedTotal', 'categoryTotal')
            );

            // Add first order - productTotal = 50, adjustedTotal = 50 (no markup)
            pipeline.add('o1', { categoryId: 'catX', productId: 'prodA', amount: 50 });
            
            let output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].categoryTotal).toBe(50);

            // Add second order - productTotal = 150 > 100, adjustedTotal = 165 (with markup)
            // categoryTotal should auto-update to 165
            pipeline.add('o2', { categoryId: 'catX', productId: 'prodA', amount: 100 });
            
            output = getOutput();
            expect(output).toHaveLength(1);
            
            // KEY ASSERTION: categoryTotal should be 165 (150 * 1.1)
            // This will FAIL until auto-detection is implemented because
            // without mutableProperties=['adjustedTotal'], the sum won't track changes
            expect(output[0].categoryTotal).toBe(165);
        });

        it('should auto-update with multiple products in same category', () => {
            // Multiple products, each with adjustedTotal computed from productTotal
            // Category sum should track all adjustedTotal changes

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    .in('products').defineProperty('adjustedTotal', item =>
                        item.productTotal > 100 ? item.productTotal * 1.2 : item.productTotal,
                        ['productTotal']
                    )
                    // Sum WITHOUT mutableProperties - should auto-detect
                    .sum('products', 'adjustedTotal', 'categoryTotal')
            );

            // Add product A with small amount (no markup)
            pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 50 });
            let output = getOutput();
            expect(output[0].categoryTotal).toBe(50); // 50, no markup

            // Add product B with small amount (no markup)
            pipeline.add('o2', { categoryId: 'cat1', productId: 'B', amount: 60 });
            output = getOutput();
            expect(output[0].categoryTotal).toBe(110); // 50 + 60 = 110

            // Push product A over threshold
            // A: 50 + 70 = 120 > 100 -> adjusted = 144
            // B: 60 (no change)
            // categoryTotal should be: 144 + 60 = 204
            pipeline.add('o3', { categoryId: 'cat1', productId: 'A', amount: 70 });
            output = getOutput();
            
            // This will FAIL until auto-detection is implemented
            expect(output[0].categoryTotal).toBe(204);

            // Push product B over threshold
            // A: 144 (adjusted)
            // B: 60 + 50 = 110 > 100 -> adjusted = 132
            // categoryTotal should be: 144 + 132 = 276
            pipeline.add('o4', { categoryId: 'cat1', productId: 'B', amount: 50 });
            output = getOutput();
            
            // This will FAIL until auto-detection is implemented
            expect(output[0].categoryTotal).toBe(276);
        });
    });

    describe('sum over nested sum result', () => {
        it('should auto-update sum when aggregating over nested sum result (without manual param)', () => {
            // Scenario: grandTotal = sum(totalOrdered) where totalOrdered = sum(amount) over orders
            //
            // Structure per customer:
            // { customerId: 'Alice', customers: [{orderId, orders, totalOrdered}], grandTotal: ... }
            //
            // Each customer gets their own grandTotal which is sum of totalOrdered for their orders.
            // When a new order is added to a customer, grandTotal should auto-update.

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ customerId: string; orderId: string; amount: number }>()
                    .groupBy(['customerId'], 'customers')
                    .in('customers').groupBy(['orderId'], 'orders')
                    .in('customers').sum('orders', 'amount', 'totalOrdered')
                    // Sum totalOrdered WITHOUT specifying mutableProperties
                    // Should auto-detect that totalOrdered is mutable (it's a sum result)
                    .sum('customers', 'totalOrdered', 'grandTotal')
            );

            // Add orders to Alice
            pipeline.add('o1', { customerId: 'Alice', orderId: 'A1', amount: 100 });
            pipeline.add('o2', { customerId: 'Alice', orderId: 'A2', amount: 200 });
            
            // Add orders to Bob
            pipeline.add('o3', { customerId: 'Bob', orderId: 'B1', amount: 50 });
            
            let output = getOutput();
            expect(output).toHaveLength(2); // One root item per customer
            
            const alice = output.find(item => item.customerId === 'Alice');
            const bob = output.find(item => item.customerId === 'Bob');
            expect(alice?.grandTotal).toBe(300); // Alice: 100 + 200
            expect(bob?.grandTotal).toBe(50);    // Bob: 50

            // Add new order to Alice - her totalOrdered should become 400
            // Alice's grandTotal should auto-update to 400, Bob's stays 50
            pipeline.add('o4', { customerId: 'Alice', orderId: 'A3', amount: 100 });
            
            output = getOutput();
            
            const aliceUpdated = output.find(item => item.customerId === 'Alice');
            const bobUpdated = output.find(item => item.customerId === 'Bob');
            
            // KEY ASSERTION: Alice's grandTotal should be 400
            expect(aliceUpdated?.grandTotal).toBe(400);
            expect(bobUpdated?.grandTotal).toBe(50); // Unchanged
        });
    });

    describe('non-mutable property should not auto-update', () => {
        it('should NOT auto-update sum when aggregating over a non-mutable property', () => {
            // Scenario: sum over a static property that isn't marked as mutable
            //
            // Structure:
            // Root
            // └── items: [{ fixedPrice: 10 }, { fixedPrice: 20 }]
            // └── total: 30
            //
            // If fixedPrice is not in mutableProperties, the TypeDescriptor won't mark it mutable
            // Therefore sum shouldn't register for onModified events
            // (This validates that auto-detection only fires for actually mutable properties)

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; fixedPrice: number }>()
                    .groupBy(['groupId'], 'items')
                    // Sum fixedPrice - this is NOT a mutable property (it's from raw input)
                    .sum('items', 'fixedPrice', 'total')
            );

            // Add items
            pipeline.add('i1', { groupId: 'G1', fixedPrice: 10 });
            pipeline.add('i2', { groupId: 'G1', fixedPrice: 20 });
            
            const output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].total).toBe(30);

            // fixedPrice is immutable input data - it can't change via the pipeline
            // This test just verifies the baseline behavior works correctly
            // The sum should correctly accumulate immutable values
        });

        it('should only track properties that are marked mutable in TypeDescriptor', () => {
            // Create a pipeline with both mutable and non-mutable properties
            // Verify that only mutable ones trigger updates

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; basePrice: number; quantity: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'items')
                    // Sum basePrice (immutable) -> productValue (mutable)
                    .in('products').sum('items', 'basePrice', 'productValue')
                    // Define a static property that doesn't depend on mutable things
                    .in('products').defineProperty('staticLabel', item => `Product-${item.productId}`, [])
                    // Sum productValue - this IS mutable, should auto-detect
                    .sum('products', 'productValue', 'categoryValue')
            );

            // Add items
            pipeline.add('i1', { categoryId: 'C1', productId: 'P1', basePrice: 100, quantity: 1 });
            
            let output = getOutput();
            expect(output[0].categoryValue).toBe(100);

            // Add more to product P1
            pipeline.add('i2', { categoryId: 'C1', productId: 'P1', basePrice: 50, quantity: 2 });
            
            output = getOutput();
            
            // categoryValue should update because productValue is mutable
            // This will FAIL until auto-detection is implemented
            expect(output[0].categoryValue).toBe(150);
        });
    });

    describe('auto-detect at nested path via in()', () => {
        it('should auto-detect when aggregating at nested path via in()', () => {
            // Scenario: Sum with auto-detection within a nested path
            //
            // Structure per category:
            // { categoryId: 'Electronics', products: [{productId, orders, productTotal, adjustedPrice}], categoryTotal: ... }
            //
            // Multiple orders go to the SAME product so that productTotal accumulates

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    // Group by category
                    .groupBy(['categoryId'], 'products')
                    // Within categories (now 'products' array), group by product
                    .in('products').groupBy(['productId'], 'orders')
                    // Sum orders for each product
                    .in('products').sum('orders', 'amount', 'productTotal')
                    // Define adjustedPrice based on productTotal (mutable dependency)
                    .in('products').defineProperty('adjustedPrice', item =>
                        item.productTotal > 100 ? item.productTotal * 1.5 : item.productTotal,
                        ['productTotal']
                    )
                    // Sum adjustedPrice at category (root) level WITHOUT mutableProperties
                    // Should auto-detect from TypeDescriptor
                    .sum('products', 'adjustedPrice', 'categoryTotal')
            );

            // Add first order - productTotal = 80, adjustedPrice = 80 (no markup)
            pipeline.add('o1', { categoryId: 'Electronics', productId: 'Phone', amount: 80 });
            
            let output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].categoryId).toBe('Electronics');
            expect(output[0].categoryTotal).toBe(80); // No markup yet

            // Add second order to SAME product - productTotal = 180 > 100 -> adjustedPrice = 270
            pipeline.add('o2', { categoryId: 'Electronics', productId: 'Phone', amount: 100 });
            
            output = getOutput();
            
            // KEY ASSERTION: categoryTotal should be 270 (180 * 1.5)
            expect(output[0].categoryTotal).toBe(270);
        });
    });

    describe('count sanity check', () => {
        it('should verify count() does not need auto-detection (no property to track)', () => {
            // count() counts items, not property values
            // It should still work correctly for add/remove
            // It doesn't have mutableProperties to auto-detect
            // This is a sanity check that we don't break count()

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; name: string }>()
                    .groupBy(['groupId'], 'items')
                    .count('items', 'itemCount')
            );

            // Add items
            pipeline.add('i1', { groupId: 'G1', name: 'Item 1' });
            pipeline.add('i2', { groupId: 'G1', name: 'Item 2' });
            pipeline.add('i3', { groupId: 'G1', name: 'Item 3' });
            
            let output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].itemCount).toBe(3);

            // Remove an item
            pipeline.remove('i2', { groupId: 'G1', name: 'Item 2' });
            
            output = getOutput();
            expect(output[0].itemCount).toBe(2);

            // Add another
            pipeline.add('i4', { groupId: 'G1', name: 'Item 4' });
            
            output = getOutput();
            expect(output[0].itemCount).toBe(3);
        });
    });

    describe('edge cases', () => {
        it('should handle property change cascade through multiple levels without manual specification', () => {
            // Complex scenario: changes cascade through multiple aggregation levels
            //
            // Level 1: orders.amount -> productTotal
            // Level 2: productTotal -> adjustedTotal (computed)
            // Level 3: adjustedTotal -> categoryTotal (sum)
            //
            // All levels should auto-update when amount changes

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    .in('products').defineProperty('adjustedTotal',
                        // Handle initial undefined productTotal gracefully
                        item => (item.productTotal ?? 0) * 1.1,
                        ['productTotal']
                    )
                    // This should auto-detect adjustedTotal is mutable
                    .sum('products', 'adjustedTotal', 'categoryTotal')
            );

            pipeline.add('o1', { categoryId: 'C1', productId: 'P1', amount: 100 });
            
            let output = getOutput();
            // productTotal = 100, adjustedTotal = 110, categoryTotal = 110
            expect(output[0].categoryTotal).toBeCloseTo(110, 5);

            // Add more to same product
            pipeline.add('o2', { categoryId: 'C1', productId: 'P1', amount: 50 });
            
            output = getOutput();
            // productTotal = 150, adjustedTotal = 165, categoryTotal = 165
            expect(output[0].categoryTotal).toBeCloseTo(165, 5);
        });
    });
});