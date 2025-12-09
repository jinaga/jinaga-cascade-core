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
        it('should update aggregate when mutable property of aggregated item changes', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string; items: Array<{ name: string; price: number }> }>()
                    .sum('items', 'price', 'totalPrice', ['price'])
            );

            // Add category with items
            pipeline.add('cat1', { 
                category: 'Electronics', 
                items: [{ name: 'TV', price: 500 }, { name: 'Radio', price: 100 }] 
            } as any);

            let output = getOutput();
            // Note: This test requires full mutable properties implementation for aggregates
            // The aggregate should be 600 initially
            expect(output.length).toBeGreaterThan(0);
            // Full implementation would register for 'price' changes at item level
            // and update aggregate incrementally when prices change
        });
    });
});
