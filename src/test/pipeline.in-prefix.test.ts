import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

/**
 * Tests for the `in()` path prefix feature.
 * 
 * These tests verify that the `in()` method allows scoping operations
 * to a specific depth within the aggregation tree, as described in
 * docs/in-path-prefix-design.md
 */

describe('pipeline in() path prefix', () => {
    describe('basic in() usage with groupBy', () => {
        it('should apply groupBy at the scoped cities level', () => {
            // Using in() to apply groupBy within the cities array
            // This creates: { state, cities: [{ city, venues: [{ venue, capacity }] }] }
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
            pipeline.add("venue3", { state: 'TX', city: 'Houston', venue: 'Center', capacity: 30000 });

            const output = getOutput();
            
            // Should have one state group
            expect(output.length).toBe(1);
            expect(output[0].state).toBe('TX');
            
            // Should have two city groups within the state
            expect(output[0].cities).toHaveLength(2);
            
            const dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            const houstonCity = output[0].cities.find(c => c.city === 'Houston');
            
            expect(dallasCity).toBeDefined();
            expect(dallasCity?.venues).toHaveLength(2);
            expect(dallasCity?.venues[0]).toEqual({ venue: 'Stadium', capacity: 50000 });
            expect(dallasCity?.venues[1]).toEqual({ venue: 'Arena', capacity: 20000 });
            
            expect(houstonCity).toBeDefined();
            expect(houstonCity?.venues).toHaveLength(1);
            expect(houstonCity?.venues[0]).toEqual({ venue: 'Center', capacity: 30000 });
        });

        it('should handle items added to existing nested groups via in().groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            // Add first venue - creates city group
            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            
            let output = getOutput();
            expect(output[0].cities[0].venues).toHaveLength(1);
            
            // Add second venue to same city - should update existing city group
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
            
            output = getOutput();
            expect(output[0].cities[0].venues).toHaveLength(2);
        });

        it('should remove items from nested groups created via in().groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            const venue1 = { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 };
            const venue2 = { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 };
            pipeline.add("venue1", venue1);
            pipeline.add("venue2", venue2);
            
            expect(getOutput()[0].cities[0].venues).toHaveLength(2);
            
            pipeline.remove("venue2", venue2);
            
            const output = getOutput();
            expect(output[0].cities[0].venues).toHaveLength(1);
            expect(output[0].cities[0].venues[0].venue).toBe('Stadium');
        });

        it('should remove nested group when all items are removed via in().groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            const venue1 = { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 };
            const venue2 = { state: 'TX', city: 'Houston', venue: 'Center', capacity: 30000 };
            pipeline.add("venue1", venue1);
            pipeline.add("venue2", venue2);
            
            expect(getOutput()[0].cities).toHaveLength(2);
            
            // Remove all venues from Dallas
            pipeline.remove("venue1", venue1);
            
            const output = getOutput();
            // Dallas city group should be removed, Houston should remain
            expect(output[0].cities).toHaveLength(1);
            expect(output[0].cities[0].city).toBe('Houston');
        });
    });

    describe('nested path with in()', () => {
        it('should apply groupBy at deeply nested level using in() with multiple path segments', () => {
            // Create: { region, states: [{ state, cities: [{ city, venues: [{ venue }] }] }] }
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ region: string, state: string, city: string, venue: string }>()
                    .groupBy(['region'], 'states')
                    .in('states').groupBy(['state'], 'cities')
                    .in('states', 'cities').groupBy(['city'], 'venues')
            );

            pipeline.add("venue1", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Stadium' });
            pipeline.add("venue2", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Arena' });
            pipeline.add("venue3", { region: 'Southwest', state: 'TX', city: 'Houston', venue: 'Center' });
            pipeline.add("venue4", { region: 'Southwest', state: 'OK', city: 'Tulsa', venue: 'Field' });

            const output = getOutput();
            
            // Should have one region
            expect(output.length).toBe(1);
            expect(output[0].region).toBe('Southwest');
            
            // Should have two states
            expect(output[0].states).toHaveLength(2);
            
            const txState = output[0].states.find(s => s.state === 'TX');
            expect(txState).toBeDefined();
            expect(txState?.cities).toHaveLength(2);
            
            const dallasCity = txState?.cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.venues).toHaveLength(2);
            
            const houstonCity = txState?.cities.find(c => c.city === 'Houston');
            expect(houstonCity?.venues).toHaveLength(1);
        });

        it('should handle four-level deep nesting with in()', () => {
            // Create: { region, states: [{ state, cities: [{ city, venues: [{ venue, events: [{ event }] }] }] }] }
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ region: string, state: string, city: string, venue: string, event: string }>()
                    .groupBy(['region'], 'states')
                    .in('states').groupBy(['state'], 'cities')
                    .in('states', 'cities').groupBy(['city'], 'venues')
                    .in('states', 'cities', 'venues').groupBy(['venue'], 'events')
            );

            pipeline.add("event1", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Stadium', event: 'Concert' });
            pipeline.add("event2", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Stadium', event: 'Game' });

            const output = getOutput();
            
            expect(output.length).toBe(1);
            expect(output[0].region).toBe('Southwest');
            expect(output[0].states[0].state).toBe('TX');
            expect(output[0].states[0].cities[0].city).toBe('Dallas');
            expect(output[0].states[0].cities[0].venues[0].venue).toBe('Stadium');
            expect(output[0].states[0].cities[0].venues[0].events).toHaveLength(2);
        });

        it('should support defineProperty at nested level', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities', 'venues').defineProperty('isLarge', (v) => v.capacity > 25000)
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            const dallasVenues = output[0].cities[0].venues;
            
            expect(dallasVenues[0].isLarge).toBe(true);
            expect(dallasVenues[1].isLarge).toBe(false);
        });
    });

    describe('in() with dropProperty', () => {
        it('should drop array at the scoped level using normalized API', () => {
            // Using in() to drop venues array within cities
            // Note: with normalized API, dropProperty takes just the property name
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').dropProperty('venues')
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput() as Array<{ state: string; cities: Array<{ city: string; venues?: unknown }> }>;
            
            // State should exist
            expect(output.length).toBe(1);
            expect(output[0].state).toBe('TX');
            
            // Cities should exist
            expect(output[0].cities).toBeDefined();
            expect(output[0].cities.length).toBeGreaterThan(0);
            
            // But venues array should be dropped
            output[0].cities.forEach((city) => {
                expect(city.venues).toBeUndefined();
                expect(city.city).toBeDefined(); // city property should remain
            });
        });

        it('should work with aggregate then dropProperty at scoped level', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').commutativeAggregate(
                        'venues',
                        'totalCapacity',
                        (acc: number | undefined, v) => (acc ?? 0) + v.capacity,
                        (acc: number, v) => acc - v.capacity
                    )
                    .in('cities').dropProperty('venues')
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput() as Array<{ state: string; cities: Array<{ city: string; totalCapacity: number; venues?: unknown }> }>;
            
            const dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(70000);
            expect(dallasCity?.venues).toBeUndefined();
        });
    });

    describe('in() with commutativeAggregate', () => {
        it('should compute aggregate at the scoped level', () => {
            // Using in() to compute aggregate within cities
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').commutativeAggregate(
                        'venues',  // Just the array name, scope provides the prefix
                        'venueCount',
                        (acc: number | undefined, _) => (acc ?? 0) + 1,
                        (acc: number, _) => acc - 1
                    )
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });
            pipeline.add("venue3", { state: 'TX', city: 'Houston', venue: 'Center', capacity: 30000 });

            const output = getOutput() as Array<{ state: string; cities: Array<{ city: string; venueCount: number }> }>;
            
            const dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            const houstonCity = output[0].cities.find(c => c.city === 'Houston');
            
            expect(dallasCity?.venueCount).toBe(2);
            expect(houstonCity?.venueCount).toBe(1);
        });

        it('should update aggregate when items are removed', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').commutativeAggregate(
                        'venues',
                        'totalCapacity',
                        (acc: number | undefined, v) => (acc ?? 0) + v.capacity,
                        (acc: number, v) => acc - v.capacity
                    )
            );

            const venue1 = { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 };
            const venue2 = { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 };
            pipeline.add("venue1", venue1);
            pipeline.add("venue2", venue2);

            let output = getOutput() as Array<{ state: string; cities: Array<{ city: string; totalCapacity: number }> }>;
            let dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(70000);

            // Remove one venue
            pipeline.remove("venue1", venue1);

            output = getOutput() as Array<{ state: string; cities: Array<{ city: string; totalCapacity: number }> }>;
            dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(20000);
        });

        it('should maintain independent aggregates for each parent in scope', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').commutativeAggregate(
                        'venues',
                        'totalCapacity',
                        (acc: number | undefined, v) => (acc ?? 0) + v.capacity,
                        (acc: number, v) => acc - v.capacity
                    )
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Houston', venue: 'Center', capacity: 30000 });
            pipeline.add("venue3", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput() as Array<{ state: string; cities: Array<{ city: string; totalCapacity: number }> }>;
            
            const dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            const houstonCity = output[0].cities.find(c => c.city === 'Houston');
            
            // Each city should have its own independent aggregate
            expect(dallasCity?.totalCapacity).toBe(70000); // 50000 + 20000
            expect(houstonCity?.totalCapacity).toBe(30000);
        });

        it('should aggregate at deeply nested level', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ region: string, state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['region'], 'states')
                    .in('states').groupBy(['state'], 'cities')
                    .in('states', 'cities').groupBy(['city'], 'venues')
                    .in('states', 'cities').commutativeAggregate(
                        'venues',
                        'totalCapacity',
                        (acc: number | undefined, v) => (acc ?? 0) + v.capacity,
                        (acc: number, v) => acc - v.capacity
                    )
            );

            pipeline.add("venue1", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { region: 'Southwest', state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput() as Array<{ region: string; states: Array<{ state: string; cities: Array<{ city: string; totalCapacity: number }> }> }>;
            
            const dallasCity = output[0].states[0].cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.totalCapacity).toBe(70000);
        });
    });

    describe('event registration with path', () => {
        it('should register events at the correct path level', () => {
            // This test verifies that when using in(), the pipeline component
            // properly registers event handlers at the specified path
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            // Add items at different levels
            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'CA', city: 'LA', venue: 'Arena', capacity: 20000 });

            const output = getOutput();
            
            // Verify state-level grouping works
            expect(output).toHaveLength(2);
            
            // Verify city-level grouping works within each state
            const txState = output.find(s => s.state === 'TX');
            const caState = output.find(s => s.state === 'CA');
            
            expect(txState?.cities).toHaveLength(1);
            expect(txState?.cities[0].city).toBe('Dallas');
            expect(txState?.cities[0].venues).toHaveLength(1);
            
            expect(caState?.cities).toHaveLength(1);
            expect(caState?.cities[0].city).toBe('LA');
            expect(caState?.cities[0].venues).toHaveLength(1);
        });

        it('should properly scope events when using multiple in() calls at different levels', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ region: string, state: string, city: string, population: number }>()
                    .groupBy(['region'], 'states')
                    .in('states').groupBy(['state'], 'cities')
                    .in('states').defineProperty('stateLabel', (s) => `State: ${s.state}`)
                    .in('states', 'cities').defineProperty('cityLabel', (c) => `City: ${c.city}`)
            );

            pipeline.add("city1", { region: 'Southwest', state: 'TX', city: 'Dallas', population: 1000000 });

            const output = getOutput();
            
            // Verify state-level property was added
            expect(output[0].states[0].stateLabel).toBe('State: TX');
            
            // Verify city-level property was added
            expect(output[0].states[0].cities[0].cityLabel).toBe('City: Dallas');
        });
    });

    describe('edge cases', () => {
        it('should handle empty in() call as no-op (root level)', () => {
            // An empty in() call should be equivalent to operating at root level
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ category: string, value: number }>()
                    .in().groupBy(['category'], 'items')
            );

            pipeline.add("item1", { category: 'A', value: 10 });
            pipeline.add("item2", { category: 'A', value: 20 });

            const output = getOutput();
            expect(output.length).toBe(1);
            expect(output[0].category).toBe('A');
            expect(output[0].items).toHaveLength(2);
        });

        it('should work with defineProperty before in().groupBy', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .defineProperty('formatted', (item) => `${item.city}, ${item.state}`)
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });

            const output = getOutput();
            // The formatted property should flow through
            expect(output[0].cities[0].venues[0].formatted).toBe('Dallas, TX');
        });

        it('should handle multiple operations at the same scope level', () => {
            const [pipeline, getOutput] = createTestPipeline(() => 
                createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                    .groupBy(['state'], 'cities')
                    .in('cities').groupBy(['city'], 'venues')
                    .in('cities').defineProperty('cityLabel', (c) => `City of ${c.city}`)
                    .in('cities').commutativeAggregate(
                        'venues',
                        'venueCount',
                        (acc: number | undefined, _) => (acc ?? 0) + 1,
                        (acc: number, _) => acc - 1
                    )
            );

            pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Stadium', capacity: 50000 });
            pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Arena', capacity: 20000 });

            const output = getOutput() as Array<{ state: string; cities: Array<{ city: string; cityLabel: string; venueCount: number }> }>;
            
            const dallasCity = output[0].cities.find(c => c.city === 'Dallas');
            expect(dallasCity?.cityLabel).toBe('City of Dallas');
            expect(dallasCity?.venueCount).toBe(2);
        });
    });
});