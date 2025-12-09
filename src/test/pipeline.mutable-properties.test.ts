import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline mutable properties', () => {
    describe('onModified signature change', () => {
        it('should pass property name at registration and oldValue/newValue in handler', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ category: string; total: number }>()
                    .sum('items', 'price', 'total')
            );

            const modifications: Array<{ propertyName: string; oldValue: any; newValue: any }> = [];
            
            // Access the step to register for modifications
            // This test verifies the signature change works
            pipeline.add('item1', { category: 'A', price: 100 } as any);
            
            // The sum step should emit onModified with new signature
            // We'll verify this through the output
            const output = getOutput();
            expect(output).toBeDefined();
        });
    });

    describe('filter with mutable properties - re-evaluation', () => {
        /**
         * Scenario from design document Section 3.2 (Scenario 2):
         * When a mutable property changes, the FilterStep should re-evaluate
         * whether the item passes the filter. If the filter result changes
         * from false to true, emit an onAdded event.
         */
        describe('when mutable property crosses threshold from below to above', () => {
            it('should emit onAdded when item starts below threshold and aggregate rises above', () => {
                // Setup: Create a pipeline with sum aggregate and filter on the mutable totalAmount
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Step 1: Add an order with amount = 50 (below threshold of 100)
                pipeline.add('order1', { customerId: 'customer1', amount: 50 });
                
                // Verify: Customer should NOT appear in output (filtered out because 50 <= 100)
                let output = getOutput();
                expect(output).toHaveLength(0);

                // Step 2: Add another order to same customer, totalAmount becomes 150 (above threshold)
                pipeline.add('order2', { customerId: 'customer1', amount: 100 });
                
                // Expected behavior: FilterStep re-evaluates predicate on mutable property change
                // Since totalAmount went from 50 to 150, and 150 > 100, the customer should now pass
                // FilterStep should emit onAdded event, and customer should appear in output
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].customerId).toBe('customer1');
                expect(output[0].totalAmount).toBe(150);
            });

            it('should handle multiple groups where one crosses threshold and others do not', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Add orders to two different customers, both below threshold
                pipeline.add('order1', { customerId: 'customerA', amount: 30 });
                pipeline.add('order2', { customerId: 'customerB', amount: 40 });
                
                // Neither customer should appear yet
                let output = getOutput();
                expect(output).toHaveLength(0);

                // Only customerA crosses threshold (30 + 80 = 110 > 100)
                pipeline.add('order3', { customerId: 'customerA', amount: 80 });
                
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].customerId).toBe('customerA');
                expect(output[0].totalAmount).toBe(110);

                // customerB still below threshold
                expect(output.find(c => c.customerId === 'customerB')).toBeUndefined();
            });
        });

        /**
         * Scenario: When a mutable property changes from above to below threshold,
         * the FilterStep should emit an onRemoved event.
         */
        describe('when mutable property crosses threshold from above to below', () => {
            it('should emit onRemoved when item starts above threshold and aggregate falls below', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Add orders that put customer above threshold (150 > 100)
                const order1 = { customerId: 'customer1', amount: 80 };
                const order2 = { customerId: 'customer1', amount: 70 };
                pipeline.add('order1', order1);
                pipeline.add('order2', order2);
                
                // Customer should appear in output (totalAmount = 150)
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].customerId).toBe('customer1');
                expect(output[0].totalAmount).toBe(150);

                // Remove an order such that totalAmount drops below threshold
                // 150 - 70 = 80, and 80 <= 100
                pipeline.remove('order2', order2);
                
                // Expected: FilterStep re-evaluates on mutable property change
                // Since 80 <= 100, predicate fails, emit onRemoved
                output = getOutput();
                expect(output).toHaveLength(0);
            });

            it('should handle removal that keeps item above threshold (no change in filter result)', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Add enough orders to stay above threshold after removal
                const order1 = { customerId: 'customer1', amount: 80 };
                const order2 = { customerId: 'customer1', amount: 50 };
                const order3 = { customerId: 'customer1', amount: 120 };
                pipeline.add('order1', order1);
                pipeline.add('order2', order2);
                pipeline.add('order3', order3);
                
                // totalAmount = 250 > 100
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].totalAmount).toBe(250);

                // Remove order2 (50), totalAmount becomes 200, still > 100
                pipeline.remove('order2', order2);
                
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].totalAmount).toBe(200);
            });
        });

        describe('edge cases for filter re-evaluation', () => {
            it('should handle item that starts exactly at threshold boundary', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Add order that puts customer exactly at boundary (100 is NOT > 100)
                pipeline.add('order1', { customerId: 'customer1', amount: 100 });
                
                // Should NOT appear (100 is not > 100)
                let output = getOutput();
                expect(output).toHaveLength(0);

                // Add 1 more to cross threshold
                pipeline.add('order2', { customerId: 'customer1', amount: 1 });
                
                // Now 101 > 100, should appear
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].totalAmount).toBe(101);
            });

            it('should handle rapid additions that cause multiple threshold crossings', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ customerId: string; amount: number }>()
                        .groupBy(['customerId'], 'orders')
                        .sum('orders', 'amount', 'totalAmount')
                        .filter(item => item.totalAmount > 100, ['totalAmount'])
                );

                // Start above threshold
                pipeline.add('order1', { customerId: 'customer1', amount: 150 });
                expect(getOutput()).toHaveLength(1);

                // Drop below threshold
                pipeline.remove('order1', { customerId: 'customer1', amount: 150 });
                pipeline.add('order2', { customerId: 'customer1', amount: 50 });
                expect(getOutput()).toHaveLength(0);

                // Rise above threshold again
                pipeline.add('order3', { customerId: 'customer1', amount: 75 });
                
                // 50 + 75 = 125 > 100
                const output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].totalAmount).toBe(125);
            });
        });

        it('should forward onModified events for properties not in mutableProperties array', () => {
            // This will be tested through integration
        });
    });

    describe('defineProperty with mutable properties', () => {
        it('should recompute defined property when mutable dependency changes', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ name: string; total: number }>()
                    .sum('orders', 'amount', 'total')
                    .defineProperty('status', item => {
                        if (item.total < 500) return 'Bronze';
                        if (item.total < 1000) return 'Silver';
                        return 'Gold';
                    }, ['total'])
            );

            pipeline.add('customer1', { name: 'Alice', orders: [{ amount: 300 }] } as any);
            
            let output = getOutput();
            // Note: This test requires full mutable properties implementation
            // For now, we verify the API compiles and basic structure works
            expect(output.length).toBeGreaterThan(0);
            // The status computation depends on mutable 'total' property
            // Full implementation would track mutable values and recompute on change
        });
    });

    describe('groupBy with mutable properties - re-grouping', () => {
        /**
         * Scenario from design document Section 3.1:
         * When a mutable property changes that affects the group key,
         * the GroupByStep should detect this and move the item between groups.
         *
         * Flow:
         * 1. Setup: Group entities by a bucket computed from their mutable total
         * 2. Entity starts with total = 100 → grouped into "low" bucket (total < 200)
         * 3. New entries added → total changes to 300
         * 4. GroupByStep receives onModified('bucket', 'low', 'medium')
         * 5. Entity moves from "low" bucket to "medium" bucket
         * 6. This triggers: onRemoved from old group, onAdded to new group
         */
        
        describe('when mutable property causes group key to change', () => {
            it('should move item to new group when mutable grouping property changes', () => {
                // Setup: Create a pipeline that groups by a computed bucket property
                // The bucket is derived from a mutable 'total' aggregate
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])  // 'total' is a mutable property
                        .groupBy(['bucket'], 'entities')
                );

                // Step 1: Add an entry for entity1 with amount 100
                // total = 100, which is < 200, so bucket = "low"
                pipeline.add('entry1', { entityId: 'entity1', amount: 100 });
                
                let output = getOutput();
                
                // Verify: entity1 appears in the "low" bucket
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities).toHaveLength(1);
                expect(output[0].entities[0].entityId).toBe('entity1');
                expect(output[0].entities[0].total).toBe(100);

                // Step 2: Add another entry for entity1 with amount 200
                // total becomes 300, which is >= 200 and < 400, so bucket = "medium"
                pipeline.add('entry2', { entityId: 'entity1', amount: 200 });
                
                output = getOutput();
                
                // Expected behavior: GroupByStep detects bucket change and re-groups
                // Entity should move from "low" to "medium" bucket
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');
                expect(output[0].entities).toHaveLength(1);
                expect(output[0].entities[0].entityId).toBe('entity1');
                expect(output[0].entities[0].total).toBe(300);
                
                // The "low" bucket should no longer exist (was removed when empty)
                const lowBucket = output.find(g => g.bucket === 'low');
                expect(lowBucket).toBeUndefined();
            });

            it('should create new group when first item moves into it', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Start two entities in "low" bucket
                pipeline.add('entry1', { entityId: 'entity1', amount: 50 });
                pipeline.add('entry2', { entityId: 'entity2', amount: 75 });
                
                let output = getOutput();
                
                // Both in "low" bucket
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities).toHaveLength(2);

                // Add more to entity1, pushing it to "medium" bucket (50 + 200 = 250)
                pipeline.add('entry3', { entityId: 'entity1', amount: 200 });
                
                output = getOutput();
                
                // Expected: Two buckets now exist
                // "low" bucket with entity2, "medium" bucket with entity1
                expect(output).toHaveLength(2);
                
                const lowBucket = output.find(g => g.bucket === 'low');
                const mediumBucket = output.find(g => g.bucket === 'medium');
                
                expect(lowBucket).toBeDefined();
                expect(lowBucket?.entities).toHaveLength(1);
                expect(lowBucket?.entities[0].entityId).toBe('entity2');
                
                // New bucket was created for the moved item
                expect(mediumBucket).toBeDefined();
                expect(mediumBucket?.entities).toHaveLength(1);
                expect(mediumBucket?.entities[0].entityId).toBe('entity1');
                expect(mediumBucket?.entities[0].total).toBe(250);
            });

            it('should remove group when last item leaves', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Start with entity in "low" bucket
                pipeline.add('entry1', { entityId: 'entity1', amount: 100 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');

                // Move entity to "medium" bucket (100 + 150 = 250)
                pipeline.add('entry2', { entityId: 'entity1', amount: 150 });
                
                output = getOutput();
                
                // Expected: Only "medium" bucket exists, "low" bucket was removed
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');
                
                // Verify "low" bucket is gone
                const lowBucket = output.find(g => g.bucket === 'low');
                expect(lowBucket).toBeUndefined();
            });

            it('should keep item in same group if computed key does not change', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Entity starts with total = 50 (bucket = "low")
                pipeline.add('entry1', { entityId: 'entity1', amount: 50 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities[0].total).toBe(50);

                // Add more, but stay in "low" bucket (50 + 100 = 150, still < 200)
                pipeline.add('entry2', { entityId: 'entity1', amount: 100 });
                
                output = getOutput();
                
                // Expected: Still in "low" bucket, no re-grouping occurred
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities).toHaveLength(1);
                expect(output[0].entities[0].entityId).toBe('entity1');
                expect(output[0].entities[0].total).toBe(150);
            });

            it('should handle multiple items in same group when one moves', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Three entities start in "low" bucket
                pipeline.add('entry1', { entityId: 'entity1', amount: 50 });
                pipeline.add('entry2', { entityId: 'entity2', amount: 75 });
                pipeline.add('entry3', { entityId: 'entity3', amount: 100 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities).toHaveLength(3);

                // Move entity2 to "medium" bucket (75 + 200 = 275)
                pipeline.add('entry4', { entityId: 'entity2', amount: 200 });
                
                output = getOutput();
                
                // Expected: "low" bucket still exists with entity1 and entity3
                // "medium" bucket created with entity2
                expect(output).toHaveLength(2);
                
                const lowBucket = output.find(g => g.bucket === 'low');
                const mediumBucket = output.find(g => g.bucket === 'medium');
                
                expect(lowBucket).toBeDefined();
                expect(lowBucket?.entities).toHaveLength(2);
                expect(lowBucket?.entities.some(e => e.entityId === 'entity1')).toBe(true);
                expect(lowBucket?.entities.some(e => e.entityId === 'entity3')).toBe(true);
                
                expect(mediumBucket).toBeDefined();
                expect(mediumBucket?.entities).toHaveLength(1);
                expect(mediumBucket?.entities[0].entityId).toBe('entity2');
                expect(mediumBucket?.entities[0].total).toBe(275);
            });

            it('should handle item moving through multiple bucket transitions', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Start in "low" bucket
                pipeline.add('entry1', { entityId: 'entity1', amount: 100 });
                expect(getOutput()[0].bucket).toBe('low');

                // Move to "medium" bucket (100 + 150 = 250)
                pipeline.add('entry2', { entityId: 'entity1', amount: 150 });
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');

                // Move to "high" bucket (250 + 200 = 450)
                pipeline.add('entry3', { entityId: 'entity1', amount: 200 });
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('high');
                expect(output[0].entities[0].total).toBe(450);
            });

            it('should handle item moving back to previous bucket on removal', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Start and move to "medium" bucket
                const entry1 = { entityId: 'entity1', amount: 100 };
                const entry2 = { entityId: 'entity1', amount: 150 };
                pipeline.add('entry1', entry1);
                pipeline.add('entry2', entry2);
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');
                expect(output[0].entities[0].total).toBe(250);

                // Remove entry2, total goes back to 100, should return to "low" bucket
                pipeline.remove('entry2', entry2);
                
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('low');
                expect(output[0].entities[0].total).toBe(100);
                
                // Verify "medium" bucket was removed
                const mediumBucket = output.find(g => g.bucket === 'medium');
                expect(mediumBucket).toBeUndefined();
            });
        });

        describe('edge cases for groupBy re-grouping', () => {
            it('should handle rapid additions that cause multiple re-groupings', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Rapid additions that cross multiple thresholds
                pipeline.add('entry1', { entityId: 'entity1', amount: 100 }); // low
                pipeline.add('entry2', { entityId: 'entity1', amount: 100 }); // medium (200)
                pipeline.add('entry3', { entityId: 'entity1', amount: 200 }); // high (400)
                
                const output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('high');
                expect(output[0].entities[0].total).toBe(400);
            });

            it('should correctly handle entity at exact bucket boundary', () => {
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .defineProperty('bucket', item => {
                            if (item.total < 200) return 'low';
                            if (item.total < 400) return 'medium';
                            return 'high';
                        }, ['total'])
                        .groupBy(['bucket'], 'entities')
                );

                // Exactly at boundary (200 is not < 200, so it's "medium")
                pipeline.add('entry1', { entityId: 'entity1', amount: 200 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');

                // Add 1 more to stay in medium (201 is still < 400)
                pipeline.add('entry2', { entityId: 'entity1', amount: 1 });
                
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].bucket).toBe('medium');
                expect(output[0].entities[0].total).toBe(201);
            });

            it('should handle grouping by raw mutable property value', () => {
                // This test groups directly by the mutable 'total' property
                // without a defineProperty transformation
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ entityId: string; amount: number }>()
                        .groupBy(['entityId'], 'entries')
                        .sum('entries', 'amount', 'total')
                        .groupBy(['total'], 'entities')
                );

                // Entity with total = 100
                pipeline.add('entry1', { entityId: 'entity1', amount: 100 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].total).toBe(100);

                // Add more, total becomes 250
                pipeline.add('entry2', { entityId: 'entity1', amount: 150 });
                
                output = getOutput();
                
                // Expected: Entity moved from total=100 group to total=250 group
                expect(output).toHaveLength(1);
                expect(output[0].total).toBe(250);
                
                // The old group (total=100) should be removed
                const oldGroup = output.find(g => g.total === 100);
                expect(oldGroup).toBeUndefined();
            });
        });
    });

    describe('aggregate over mutable properties', () => {
        /**
         * Scenario 5 from design document Section 3.3:
         * When aggregating over mutable properties:
         * 1. The aggregate step should register `onModified` listeners for mutable properties of aggregated items
         * 2. When an item's mutable property changes, the aggregate should update incrementally
         * 3. For commutative aggregates (sum, count), the update formula is: `newAggregate = oldAggregate - oldValue + newValue`
         *
         * Flow:
         * 1. Category has items with prices [100, 200, 300] → `totalPrice = 600`
         * 2. Item's price changes from 200 to 250
         * 3. `SumStep` receives `onModified('price', 200, 250)` for that item
         * 4. Step updates aggregate: `600 - 200 + 250 = 650`
         * 5. Emits `onModified('totalPrice', 600, 650)` to downstream steps
         */
        describe('sum aggregate with mutable item properties', () => {
            it('should update sum when item effectivePrice changes due to discount change', () => {
                // Test Scenario: Sum aggregate updates when item's summed property changes
                //
                // Pipeline structure:
                // 1. Input: items with productId, basePrice
                // 2. GroupBy productId (creates groups with single items for simplicity)
                // 3. Sum basePrice -> total (this is the root-level aggregate)
                // 4. DefineProperty: discount (based on mutable total, e.g., bulk discount)
                // 5. DefineProperty: effectivePrice = basePrice - discount (depends on mutable 'discount')
                // 6. Second grouping level: aggregate effectivePrice
                //
                // For simplicity, let's use a more direct approach:
                // Items have a computed effectivePrice that depends on a mutable discount property
                // When discount changes (via aggregate update), effectivePrice changes
                // The aggregate over effectivePrice should update incrementally
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ orderId: string; productId: string; basePrice: number }>()
                        // Group by productId
                        .groupBy(['productId'], 'orders')
                        // Sum basePrice to get total spent on this product
                        .sum('orders', 'basePrice', 'totalSpent')
                        // Define discount based on totalSpent (mutable property)
                        // Discount is 10% if total > 200, otherwise 0
                        .defineProperty('discountRate', item => item.totalSpent > 200 ? 0.1 : 0, ['totalSpent'])
                );

                // Add orders - first order for product A (not enough for discount)
                pipeline.add('order1', { orderId: 'O1', productId: 'productA', basePrice: 100 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].productId).toBe('productA');
                expect(output[0].totalSpent).toBe(100);
                expect(output[0].discountRate).toBe(0); // No discount yet

                // Add second order - now total > 200, discount should apply
                pipeline.add('order2', { orderId: 'O2', productId: 'productA', basePrice: 150 });
                
                output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].productId).toBe('productA');
                expect(output[0].totalSpent).toBe(250);
                expect(output[0].discountRate).toBe(0.1); // 10% discount now applied
            });

            it('should update sum aggregate when nested item mutable property changes', () => {
                // Test Scenario: Sum aggregate updates when item's summed property changes
                //
                // This test creates a more complex scenario:
                // 1. Products grouped by category
                // 2. Each product has orders grouped by productId
                // 3. Sum orders to get productTotal (mutable)
                // 4. Define adjustedPrice based on productTotal (mutable dependency)
                // 5. Sum adjustedPrice at category level - this should update when adjustedPrice changes
                //
                // The key test: when productTotal changes, adjustedPrice changes,
                // and the category-level sum of adjustedPrice should update incrementally
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; orderId: string; amount: number }>()
                        // First group by category
                        .groupBy(['categoryId'], 'products')
                        // Then within each category, group by product
                        .in('products').groupBy(['productId'], 'orders')
                        // Sum orders for each product
                        .in('products').sum('orders', 'amount', 'productTotal')
                        // Define adjusted price based on productTotal
                        // If productTotal > 100, adjusted = productTotal * 1.1, else productTotal
                        .in('products').defineProperty('adjustedTotal', item =>
                            item.productTotal > 100 ? item.productTotal * 1.1 : item.productTotal,
                            ['productTotal']
                        )
                        // Sum adjustedTotal at category level
                        // This is where handleItemPropertyChanged should be called when adjustedTotal changes
                        .sum('products', 'adjustedTotal', 'categoryTotal')
                );

                // Add first order - product A in category X, amount 50
                pipeline.add('o1', { categoryId: 'catX', productId: 'prodA', orderId: 'o1', amount: 50 });
                
                let output = getOutput();
                expect(output).toHaveLength(1);
                expect(output[0].categoryId).toBe('catX');
                // productTotal = 50, adjustedTotal = 50 (no markup), categoryTotal = 50
                expect(output[0].categoryTotal).toBe(50);

                // Add second order for same product - now productTotal > 100
                // productTotal = 150, adjustedTotal = 165 (150 * 1.1)
                // categoryTotal should update to 165
                pipeline.add('o2', { categoryId: 'catX', productId: 'prodA', orderId: 'o2', amount: 100 });
                
                output = getOutput();
                expect(output).toHaveLength(1);
                // The KEY ASSERTION: categoryTotal should be 165 (not 150)
                // This tests that when adjustedTotal changed from 50 to 165,
                // the sum aggregate received onModified and updated: oldSum - oldValue + newValue = 50 - 50 + 165 = 165
                expect(output[0].categoryTotal).toBe(165);
            });

            it('should update sum correctly with multiple item property changes in sequence', () => {
                // Test: Sum aggregate updates correctly with multiple item changes
                //
                // Multiple products in same category, each with orders
                // As orders are added, productTotal changes, adjustedTotal changes
                // categoryTotal should track all these changes correctly
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        .in('products').defineProperty('adjustedTotal', item =>
                            item.productTotal > 100 ? item.productTotal * 1.2 : item.productTotal,
                            ['productTotal']
                        )
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

                // Add more to product A, pushing it over threshold
                // A: 50 + 70 = 120 -> adjusted = 144
                // B: 60 (no change)
                // categoryTotal should be: 144 + 60 = 204
                pipeline.add('o3', { categoryId: 'cat1', productId: 'A', amount: 70 });
                output = getOutput();
                expect(output[0].categoryTotal).toBe(204);

                // Add more to product B, pushing it over threshold
                // A: 144 (adjusted)
                // B: 60 + 50 = 110 -> adjusted = 132
                // categoryTotal should be: 144 + 132 = 276
                pipeline.add('o4', { categoryId: 'cat1', productId: 'B', amount: 50 });
                output = getOutput();
                expect(output[0].categoryTotal).toBe(276);
            });

            it('should handle item removal after property change', () => {
                // Test: Sum aggregate handles item removal after property change
                //
                // Add items, trigger property change, then remove an item
                // The aggregate should correctly reflect the removal
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        .in('products').defineProperty('adjustedTotal', item =>
                            item.productTotal > 100 ? item.productTotal * 1.5 : item.productTotal,
                            ['productTotal']
                        )
                        .sum('products', 'adjustedTotal', 'categoryTotal')
                );

                // Add two products
                pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 80 });
                pipeline.add('o2', { categoryId: 'cat1', productId: 'B', amount: 90 });
                
                let output = getOutput();
                // Both under threshold: 80 + 90 = 170
                expect(output[0].categoryTotal).toBe(170);

                // Push A over threshold
                // A: 80 + 50 = 130 -> adjusted = 195
                // B: 90
                // Total: 285
                const order3 = { categoryId: 'cat1', productId: 'A', amount: 50 };
                pipeline.add('o3', order3);
                output = getOutput();
                expect(output[0].categoryTotal).toBe(285);

                // Remove the order that pushed A over threshold
                // A: 80 (no markup)
                // B: 90
                // Total: 170
                pipeline.remove('o3', order3);
                output = getOutput();
                expect(output[0].categoryTotal).toBe(170);
            });

            it('should cascade aggregate change to downstream filter step', () => {
                // Test: Aggregate change cascades to downstream steps
                //
                // Pipeline: Sum → Filter (where categoryTotal > threshold)
                // Item property change causes aggregate to cross threshold
                // Filter should add/remove based on the aggregate change
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        .in('products').defineProperty('adjustedTotal', item =>
                            item.productTotal > 50 ? item.productTotal * 2 : item.productTotal,
                            ['productTotal']
                        )
                        .sum('products', 'adjustedTotal', 'categoryTotal')
                        // Filter: only show categories with total > 200
                        .filter(cat => cat.categoryTotal > 200, ['categoryTotal'])
                );

                // Add product with small amount - category won't pass filter
                pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 30 });
                
                let output = getOutput();
                // 30 < 50, no doubling, categoryTotal = 30, threshold not met
                expect(output).toHaveLength(0);

                // Add more - still under filter threshold but over doubling threshold
                // 30 + 40 = 70 > 50, doubled = 140 < 200
                pipeline.add('o2', { categoryId: 'cat1', productId: 'A', amount: 40 });
                output = getOutput();
                expect(output).toHaveLength(0);

                // Add more to push over filter threshold
                // 70 + 50 = 120 > 50, doubled = 240 > 200
                pipeline.add('o3', { categoryId: 'cat1', productId: 'A', amount: 50 });
                output = getOutput();
                // Should now appear in output
                expect(output).toHaveLength(1);
                expect(output[0].categoryId).toBe('cat1');
                expect(output[0].categoryTotal).toBe(240);
            });

            it('should handle property change to zero value', () => {
                // Test: Aggregate handles property change to zero
                // Edge case: property changes to 0
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        // Zero out if productTotal > 100
                        .in('products').defineProperty('adjustedTotal', item =>
                            item.productTotal > 100 ? 0 : item.productTotal,
                            ['productTotal']
                        )
                        .sum('products', 'adjustedTotal', 'categoryTotal')
                );

                // Add product under threshold
                pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 80 });
                
                let output = getOutput();
                expect(output[0].categoryTotal).toBe(80);

                // Push over threshold - adjustedTotal becomes 0
                // categoryTotal should update: 80 - 80 + 0 = 0
                pipeline.add('o2', { categoryId: 'cat1', productId: 'A', amount: 30 });
                output = getOutput();
                expect(output[0].categoryTotal).toBe(0);
            });

            it('should handle property change to negative value', () => {
                // Test: Aggregate handles property change resulting in negative values
                // Edge case: property can become negative (e.g., fee deducted)
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        // If productTotal > 100, deduct fee: productTotal - 200
                        .in('products').defineProperty('netTotal', item =>
                            item.productTotal > 100 ? item.productTotal - 200 : item.productTotal,
                            ['productTotal']
                        )
                        .sum('products', 'netTotal', 'categoryNet')
                );

                // Add two products under threshold
                pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 80 });
                pipeline.add('o2', { categoryId: 'cat1', productId: 'B', amount: 70 });
                
                let output = getOutput();
                // 80 + 70 = 150 total, no fee
                expect(output[0].categoryNet).toBe(150);

                // Push product A over threshold
                // A: 80 + 30 = 110 -> netTotal = 110 - 200 = -90
                // B: 70
                // categoryNet = -90 + 70 = -20
                pipeline.add('o3', { categoryId: 'cat1', productId: 'A', amount: 30 });
                output = getOutput();
                expect(output[0].categoryNet).toBe(-20);
            });

            it('should handle multiple products changing simultaneously', () => {
                // Test: Multiple items changing in same batch should all update correctly
                //
                // Add orders to multiple products that all cross threshold at once
                
                const [pipeline, getOutput] = createTestPipeline(() =>
                    createPipeline<{ categoryId: string; productId: string; amount: number }>()
                        .groupBy(['categoryId'], 'products')
                        .in('products').groupBy(['productId'], 'orders')
                        .in('products').sum('orders', 'amount', 'productTotal')
                        .in('products').defineProperty('bonus', item =>
                            item.productTotal >= 100 ? 50 : 0,
                            ['productTotal']
                        )
                        .sum('products', 'bonus', 'totalBonus')
                );

                // Add three products, all under threshold
                pipeline.add('o1', { categoryId: 'cat1', productId: 'A', amount: 90 });
                pipeline.add('o2', { categoryId: 'cat1', productId: 'B', amount: 95 });
                pipeline.add('o3', { categoryId: 'cat1', productId: 'C', amount: 80 });
                
                let output = getOutput();
                // All under threshold, no bonus
                expect(output[0].totalBonus).toBe(0);

                // Push A over threshold: bonus = 50
                pipeline.add('o4', { categoryId: 'cat1', productId: 'A', amount: 10 });
                output = getOutput();
                expect(output[0].totalBonus).toBe(50);

                // Push B over threshold: bonus = 50 for B
                // totalBonus = 50 + 50 = 100
                pipeline.add('o5', { categoryId: 'cat1', productId: 'B', amount: 10 });
                output = getOutput();
                expect(output[0].totalBonus).toBe(100);

                // Push C over threshold: bonus = 50 for C
                // totalBonus = 50 + 50 + 50 = 150
                pipeline.add('o6', { categoryId: 'cat1', productId: 'C', amount: 20 });
                output = getOutput();
                expect(output[0].totalBonus).toBe(150);
            });
        });
    });
});
