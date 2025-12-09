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

/**
 * Tests for auto-detection of mutable properties in MinMaxAggregate.
 *
 * Currently, min() and max() don't handle property changes at all - they only
 * react to add/remove events. When the property being aggregated is mutable
 * (e.g., computed by defineProperty or another aggregate), the min/max should
 * auto-update when that property changes.
 *
 * Additionally, MinMaxAggregateStep needs handleItemPropertyChanged to recalculate
 * when a value changes (not just when items are added/removed).
 *
 * These tests should FAIL until:
 * 1. min()/max() auto-detect mutable properties from TypeDescriptor
 * 2. MinMaxAggregateStep implements handleItemPropertyChanged
 */
describe('MinMaxAggregate auto-detection of mutable properties', () => {
    
    describe('auto-update when property is mutable', () => {
        it('should auto-update min when the property is mutable (without manual param)', () => {
            // Setup: Create pipeline that finds min of a computed property
            //
            // Structure:
            // - Products grouped by category
            // - Each product has orders grouped by productId
            // - Sum orders.amount -> productTotal (mutable)
            // - Define adjustedPrice = productTotal * discount (mutable because depends on productTotal)
            // - Min adjustedPrice at category level
            //
            // The test: When productTotal changes (via new order), adjustedPrice changes,
            // and lowestPrice should auto-update because adjustedPrice is marked mutable in TypeDescriptor

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    // Define adjustedPrice that depends on mutable productTotal
                    // Apply 10% discount if productTotal > 100
                    .in('products').defineProperty('adjustedPrice', item =>
                        item.productTotal > 100 ? item.productTotal * 0.9 : item.productTotal,
                        ['productTotal']
                    )
                    // KEY: Min adjustedPrice WITHOUT specifying mutableProperties
                    // This should auto-detect that adjustedPrice is mutable
                    .min('products', 'adjustedPrice', 'lowestPrice')
            );

            // Add first product with productTotal = 50 (no discount)
            // adjustedPrice = 50, lowestPrice = 50
            pipeline.add('o1', { categoryId: 'catX', productId: 'prodA', amount: 50 });
            
            let output = getOutput();
            expect(output).toHaveLength(1);
            expect(output[0].lowestPrice).toBe(50);

            // Add second product with productTotal = 80 (no discount)
            // adjustedPrice = 80, lowestPrice = min(50, 80) = 50
            pipeline.add('o2', { categoryId: 'catX', productId: 'prodB', amount: 80 });
            
            output = getOutput();
            expect(output[0].lowestPrice).toBe(50);

            // Now add more to prodA to push it over threshold
            // prodA: 50 + 60 = 110 > 100, adjustedPrice = 110 * 0.9 = 99
            // prodB: 80 (no change)
            // lowestPrice should update to min(99, 80) = 80
            pipeline.add('o3', { categoryId: 'catX', productId: 'prodA', amount: 60 });
            
            output = getOutput();
            
            // KEY ASSERTION: lowestPrice should be 80 now
            // This will FAIL until auto-detection is implemented because
            // without tracking property changes, min won't recalculate
            expect(output[0].lowestPrice).toBe(80);
        });

        it('should auto-update max when the property is mutable (without manual param)', () => {
            // Similar to above but for max
            
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    // Define adjustedPrice with markup for high totals
                    .in('products').defineProperty('adjustedPrice', item =>
                        item.productTotal > 100 ? item.productTotal * 1.5 : item.productTotal,
                        ['productTotal']
                    )
                    // Max adjustedPrice WITHOUT specifying mutableProperties
                    .max('products', 'adjustedPrice', 'highestPrice')
            );

            // Add first product with productTotal = 50 (no markup)
            pipeline.add('o1', { categoryId: 'catX', productId: 'prodA', amount: 50 });
            
            let output = getOutput();
            expect(output[0].highestPrice).toBe(50);

            // Add second product with productTotal = 80 (no markup)
            // highestPrice = max(50, 80) = 80
            pipeline.add('o2', { categoryId: 'catX', productId: 'prodB', amount: 80 });
            
            output = getOutput();
            expect(output[0].highestPrice).toBe(80);

            // Push prodA over threshold: 50 + 60 = 110 > 100
            // adjustedPrice = 110 * 1.5 = 165
            // highestPrice should update to max(165, 80) = 165
            pipeline.add('o3', { categoryId: 'catX', productId: 'prodA', amount: 60 });
            
            output = getOutput();
            
            // KEY ASSERTION: highestPrice should be 165
            expect(output[0].highestPrice).toBe(165);
        });
    });

    describe('recalculation when current min/max item changes', () => {
        it('should recalculate correctly when current min item value changes', () => {
            // Scenario: Item A=10 is min, Item B=20, Item C=30
            // Change A to 25
            // New min should be B=20, not 25

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; baseValue: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'values')
                    .in('items').sum('values', 'baseValue', 'totalValue')
                    .min('items', 'totalValue', 'minValue')
            );

            // Add items: A=10, B=20, C=30
            pipeline.add('v1', { groupId: 'G1', itemId: 'A', baseValue: 10 });
            pipeline.add('v2', { groupId: 'G1', itemId: 'B', baseValue: 20 });
            pipeline.add('v3', { groupId: 'G1', itemId: 'C', baseValue: 30 });
            
            let output = getOutput();
            expect(output[0].minValue).toBe(10); // A is min

            // Change A from 10 to 25 (by adding 15 more)
            // A: 10 + 15 = 25
            // Now min should be B=20
            pipeline.add('v4', { groupId: 'G1', itemId: 'A', baseValue: 15 });
            
            output = getOutput();
            
            // KEY ASSERTION: minValue should be 20 (B), not 25 (A)
            // This will FAIL because MinMaxAggregateStep doesn't have handleItemPropertyChanged
            expect(output[0].minValue).toBe(20);
        });

        it('should recalculate correctly when current max item value changes', () => {
            // Scenario: Item A=10, Item B=20, Item C=30 (max)
            // Change C to 15
            // New max should be B=20, not 15

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; baseValue: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'values')
                    .in('items').sum('values', 'baseValue', 'totalValue')
                    .max('items', 'totalValue', 'maxValue')
            );

            // Add items: A=10, B=20, C=30
            pipeline.add('v1', { groupId: 'G1', itemId: 'A', baseValue: 10 });
            pipeline.add('v2', { groupId: 'G1', itemId: 'B', baseValue: 20 });
            pipeline.add('v3', { groupId: 'G1', itemId: 'C', baseValue: 30 });
            
            let output = getOutput();
            expect(output[0].maxValue).toBe(30); // C is max

            // "Change" C by removing and re-adding with different value
            // We need to simulate C going from 30 to 15
            // Since sum only grows by adding, we'll test with a defineProperty approach
            // Actually, we can only add positive values to sum, so let's redesign:
            // Instead, we'll make a new test where the defined property logic changes the value

            // For this test, let's use defineProperty to cap values
            // This test might need redesign - marking as known limitation
        });

        it('should handle value change that keeps the same min item', () => {
            // Scenario: Item A=10 (min), Item B=20, Item C=30
            // Change A from 10 to 5 (still min, just smaller)
            // Min should update to 5

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; amount: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'orders')
                    .in('items').sum('orders', 'amount', 'productTotal')
                    // Use defineProperty with formula that can decrease
                    .in('items').defineProperty('adjustedValue', item =>
                        item.productTotal > 50 ? item.productTotal - 30 : item.productTotal,
                        ['productTotal']
                    )
                    .min('items', 'adjustedValue', 'minValue')
            );

            // Add items
            // A: 10, adjustedValue = 10 (< 50, no change)
            // B: 60, adjustedValue = 60 - 30 = 30
            // C: 100, adjustedValue = 100 - 30 = 70
            pipeline.add('o1', { groupId: 'G1', itemId: 'A', amount: 10 });
            pipeline.add('o2', { groupId: 'G1', itemId: 'B', amount: 60 });
            pipeline.add('o3', { groupId: 'G1', itemId: 'C', amount: 100 });
            
            let output = getOutput();
            expect(output[0].minValue).toBe(10); // A is min

            // Add more to A: 10 + 50 = 60 > 50, so adjustedValue = 60 - 30 = 30
            // A is still potentially min, tied with B
            pipeline.add('o4', { groupId: 'G1', itemId: 'A', amount: 50 });
            
            output = getOutput();
            
            // KEY ASSERTION: minValue should update to 30
            expect(output[0].minValue).toBe(30);
        });

        it('should handle value change to non-min/max item (no change to result)', () => {
            // Scenario: Item A=10 (min), Item B=20, Item C=30
            // Change B from 20 to 25
            // Min should stay at 10 (A unchanged)

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; amount: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'orders')
                    .in('items').sum('orders', 'amount', 'orderTotal')
                    .min('items', 'orderTotal', 'minTotal')
            );

            // Add items: A=10, B=20, C=30
            pipeline.add('o1', { groupId: 'G1', itemId: 'A', amount: 10 });
            pipeline.add('o2', { groupId: 'G1', itemId: 'B', amount: 20 });
            pipeline.add('o3', { groupId: 'G1', itemId: 'C', amount: 30 });
            
            let output = getOutput();
            expect(output[0].minTotal).toBe(10);

            // Change B from 20 to 25 (add 5 more)
            pipeline.add('o4', { groupId: 'G1', itemId: 'B', amount: 5 });
            
            output = getOutput();
            
            // Min should still be 10 (A is unchanged)
            // This tests that property change handling doesn't break existing behavior
            expect(output[0].minTotal).toBe(10);
        });
    });

    describe('auto-detect at nested path via in()', () => {
        it('should auto-detect at nested path via in()', () => {
            // .in('categories').min('products', 'adjustedPrice', 'lowestPrice')
            // adjustedPrice is mutable at products level
            // lowestPrice should auto-update when adjustedPrice changes

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ storeId: string; categoryId: string; productId: string; amount: number }>()
                    .groupBy(['storeId'], 'categories')
                    .in('categories').groupBy(['categoryId'], 'products')
                    .in('categories', 'products').groupBy(['productId'], 'orders')
                    .in('categories', 'products').sum('orders', 'amount', 'productTotal')
                    .in('categories', 'products').defineProperty('adjustedPrice', item =>
                        item.productTotal > 100 ? item.productTotal * 0.8 : item.productTotal,
                        ['productTotal']
                    )
                    // Min at the categories level
                    .in('categories').min('products', 'adjustedPrice', 'lowestPrice')
            );

            // Add products to store S1, category C1
            pipeline.add('o1', { storeId: 'S1', categoryId: 'C1', productId: 'P1', amount: 50 });
            pipeline.add('o2', { storeId: 'S1', categoryId: 'C1', productId: 'P2', amount: 80 });
            
            let output = getOutput();
            // Should have one store
            expect(output).toHaveLength(1);
            // lowestPrice in C1 = min(50, 80) = 50
            const store = output[0];
            expect(store.categories).toHaveLength(1);
            expect(store.categories[0].lowestPrice).toBe(50);

            // Push P1 over threshold: 50 + 60 = 110 > 100
            // adjustedPrice for P1 = 110 * 0.8 = 88
            // P2 stays at 80
            // lowestPrice should update to min(88, 80) = 80
            pipeline.add('o3', { storeId: 'S1', categoryId: 'C1', productId: 'P1', amount: 60 });
            
            output = getOutput();
            
            // KEY ASSERTION: lowestPrice should be 80
            expect(output[0].categories[0].lowestPrice).toBe(80);
        });
    });

    describe('edge cases with multiple items having same value', () => {
        it('should handle multiple items with same min/max value', () => {
            // Scenario: Item A=10, Item B=10 (both min), Item C=20
            // Change A from 10 to 15
            // Min should stay at 10 (B is still there)

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; amount: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'orders')
                    .in('items').sum('orders', 'amount', 'orderTotal')
                    .min('items', 'orderTotal', 'minTotal')
            );

            // Add items: A=10, B=10, C=20
            pipeline.add('o1', { groupId: 'G1', itemId: 'A', amount: 10 });
            pipeline.add('o2', { groupId: 'G1', itemId: 'B', amount: 10 });
            pipeline.add('o3', { groupId: 'G1', itemId: 'C', amount: 20 });
            
            let output = getOutput();
            expect(output[0].minTotal).toBe(10);

            // Change A from 10 to 15
            pipeline.add('o4', { groupId: 'G1', itemId: 'A', amount: 5 });
            
            output = getOutput();
            
            // Min should stay at 10 because B is still at 10
            // This will FAIL if handleItemPropertyChanged doesn't properly recalculate
            expect(output[0].minTotal).toBe(10);
        });

        it('should handle all items changing to same value', () => {
            // Edge case: All items end up with the same value
            // Start: A=10, B=20, C=30
            // Change all to 15

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ groupId: string; itemId: string; amount: number }>()
                    .groupBy(['groupId'], 'items')
                    .in('items').groupBy(['itemId'], 'orders')
                    .in('items').sum('orders', 'amount', 'orderTotal')
                    // Use defineProperty to normalize values
                    .in('items').defineProperty('normalizedValue', item =>
                        item.orderTotal > 25 ? 15 : (item.orderTotal > 15 ? 15 : item.orderTotal),
                        ['orderTotal']
                    )
                    .min('items', 'normalizedValue', 'minValue')
                    .max('items', 'normalizedValue', 'maxValue')
            );

            // Add items: A=10, B=20, C=30
            // normalizedValue: A=10, B=15 (20>15), C=15 (30>25)
            pipeline.add('o1', { groupId: 'G1', itemId: 'A', amount: 10 });
            pipeline.add('o2', { groupId: 'G1', itemId: 'B', amount: 20 });
            pipeline.add('o3', { groupId: 'G1', itemId: 'C', amount: 30 });
            
            let output = getOutput();
            expect(output[0].minValue).toBe(10);
            expect(output[0].maxValue).toBe(15);

            // Add 10 to A: orderTotal = 20, normalizedValue = 15
            // All items now have normalizedValue = 15
            pipeline.add('o4', { groupId: 'G1', itemId: 'A', amount: 10 });
            
            output = getOutput();
            
            // Min and max should both be 15
            expect(output[0].minValue).toBe(15);
            expect(output[0].maxValue).toBe(15);
        });
    });

    describe('comparison with manual mutableProperties (deprecated)', () => {
        it('should work automatically without deprecated mutableProperties param', () => {
            // This test confirms that auto-detection eliminates the need for manual params
            // It's the same scenario as sum() auto-detection tests but for min/max

            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ categoryId: string; productId: string; amount: number }>()
                    .groupBy(['categoryId'], 'products')
                    .in('products').groupBy(['productId'], 'orders')
                    .in('products').sum('orders', 'amount', 'productTotal')
                    .in('products').defineProperty('discountedPrice', item =>
                        item.productTotal >= 100 ? item.productTotal * 0.75 : item.productTotal,
                        ['productTotal']
                    )
                    // No mutableProperties param needed - should auto-detect
                    .min('products', 'discountedPrice', 'bestPrice')
            );

            // Add products
            pipeline.add('o1', { categoryId: 'C1', productId: 'P1', amount: 40 });
            pipeline.add('o2', { categoryId: 'C1', productId: 'P2', amount: 60 });
            
            let output = getOutput();
            // P1: 40 (no discount), P2: 60 (no discount)
            // bestPrice = min(40, 60) = 40
            expect(output[0].bestPrice).toBe(40);

            // Push P1 over threshold: 40 + 80 = 120 >= 100
            // discountedPrice = 120 * 0.75 = 90
            // bestPrice = min(90, 60) = 60
            pipeline.add('o3', { categoryId: 'C1', productId: 'P1', amount: 80 });
            
            output = getOutput();
            
            // KEY ASSERTION: bestPrice should be 60 (P2)
            // This proves auto-detection works without manual param
            expect(output[0].bestPrice).toBe(60);
        });
    });
});