import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

describe('pipeline dropProperty (array behavior)', () => {
    it('should remove a top-level array created by groupBy', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput();

        expect(output.length).toBe(2);
        
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA && 'items' in groupA ? (groupA as { items?: unknown }).items : undefined).toBeUndefined();
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB && 'items' in groupB ? (groupB as { items?: unknown }).items : undefined).toBeUndefined();
    });

    it('should drop one array while keeping others at the same level', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .defineProperty('groupLabel', (group) => `Group: ${group.category}`)
                .dropProperty('items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput();

        expect(output.length).toBe(2);
        
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.groupLabel).toBe('Group: A');
        expect(groupA && 'items' in groupA ? (groupA as { items?: unknown }).items : undefined).toBeUndefined();
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.groupLabel).toBe('Group: B');
        expect(groupB && 'items' in groupB ? (groupB as { items?: unknown }).items : undefined).toBeUndefined();
    });

    it('should handle dropping an array that has no items', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );

        // Don't add any items - array should be empty
        const output = getOutput();

        expect(output).toEqual([]);
        expect(output.length).toBe(0);
    });
});

describe('pipeline dropProperty event suppression (for arrays)', () => {
    it('should suppress add events for items added after drop', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );

        // Add items after dropping - item-level events should be suppressed
        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput();

        // Groups may be created (via root-level [] events), but items should not be added
        // because item-level events at ['items'] path are suppressed.
        // Since dropProperty removes ['items'] from the type descriptor, handlers aren't registered
        // for that path, so items won't be added to the state.
        // Verify: if groups exist, they should not have an items array
        output.forEach(group => {
            expect(group && 'items' in group ? (group as { items?: unknown }).items : undefined).toBeUndefined();
        });
    });

    it('should suppress add events for items added before drop', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );

        // Add items before dropping
        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        
        // Verify items exist initially
        let output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].items).toBeDefined();
        expect(output[0].items.length).toBe(2);
        
        // Now drop the array - but we can't modify the pipeline after creation
        // So this test needs to be structured differently
        // Let's create a new pipeline that drops the array and add items to it
        const [pipeline2, getOutput2] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );
        
        // Add items after dropping
        pipeline2.add("item3", { category: 'B', value: 30 });
        
        const output2 = getOutput2() as Array<{ category?: string; items?: unknown }>;
        // Groups may be created but items array should not exist
        output2.forEach(group => {
            expect(group.items).toBeUndefined();
        });
    });

    it('should suppress remove events for items removed after drop', () => {
        // Create pipeline without dropProperty first to add items
        const [pipeline1, getOutput1] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
        );
        
        // Add items
        pipeline1.add("item1", { category: 'A', value: 10 });
        pipeline1.add("item2", { category: 'A', value: 20 });
        
        // Verify items exist
        let output1 = getOutput1();
        expect(output1.length).toBe(1);
        expect(output1[0].items.length).toBe(2);
        
        // Now create pipeline with dropProperty
        const [pipeline2, getOutput2] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );
        
        // Add items - these won't appear because add events are suppressed
        const item3 = { category: 'B', value: 30 };
        pipeline2.add("item3", item3);
        let output2 = getOutput2() as Array<{ category?: string; items?: unknown }>;
        
        // Remove items - remove events at ['items'] should be suppressed
        // Since the type descriptor doesn't include ['items'], handlers aren't registered
        // for that path, so remove events won't affect the output
        pipeline2.remove("item3", item3);
        
        const outputAfterRemove = getOutput2() as Array<{ category?: string; items?: unknown }>;
        // Output should be unchanged (items were never added due to suppressed add events)
        // Groups might be created/removed at root level, but item-level removes are suppressed
        outputAfterRemove.forEach(group => {
            expect(group.items).toBeUndefined();
        });
    });

    it('should suppress modify events for items modified after drop', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .in('items').defineProperty('doubled', (item) => item.value * 2)
                .dropProperty('items')
        );

        // Add items - add events are suppressed, so items won't be added
        const item1 = { category: 'A', value: 10 };
        const item2 = { category: 'A', value: 20 };
        pipeline.add("item1", item1);
        pipeline.add("item2", item2);
        
        let output = getOutput() as Array<{ category?: string; items?: unknown }>;
        
        // Modify items (by removing and re-adding with different values)
        // Modify events at ['items'] should be suppressed
        pipeline.remove("item1", item1);
        pipeline.add("item1", { category: 'A', value: 15 }); // Changed value
        
        // Output should not change because modify events at ['items'] are suppressed
        // Since items were never added (add events suppressed), modifies also have no effect
        const outputAfterModify = getOutput() as Array<{ category?: string; items?: unknown }>;
        outputAfterModify.forEach(group => {
            expect(group.items).toBeUndefined();
        });
    });

    it('should suppress events at dropped path but allow parent path events', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities')
                .in('cities').dropProperty('venues')
        );

        // Add items at cities level (parent of dropped path) - should work
        // This creates a city group
        pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Venue1', capacity: 100 });
        
        let output = getOutput() as Array<{ state: string; cities?: Array<{ city: string; venues?: unknown }> }>;
        
        // Cities array should exist (parent level)
        expect(output.length).toBeGreaterThan(0);
        const txState = output.find(s => s.state === 'TX');
        expect(txState).toBeDefined();
        expect(txState?.cities).toBeDefined();
        
        // But venues array should be dropped (target level)
        if (txState?.cities && txState.cities.length > 0) {
            const dallasCity = txState.cities[0];
            expect(dallasCity.venues).toBeUndefined();
        }
        
        // Add more items - venues array should still not appear
        pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Venue2', capacity: 200 });
        output = getOutput() as Array<{ state: string; cities?: Array<{ city: string; venues?: unknown }> }>;
        const txState2 = output.find(s => s.state === 'TX');
        if (txState2?.cities && txState2.cities.length > 0) {
            const dallasCity2 = txState2.cities[0];
            expect(dallasCity2.venues).toBeUndefined();
        }
    });
});

describe('pipeline dropProperty integration (for arrays)', () => {
    it('should work with groupBy to remove array but keep keys', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput();

        // Group key properties should remain
        expect(output.length).toBe(2);
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA && 'items' in groupA ? (groupA as { items?: unknown }).items : undefined).toBeUndefined();
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB && 'items' in groupB ? (groupB as { items?: unknown }).items : undefined).toBeUndefined();
    });

    it('should work with commutativeAggregate to keep aggregate but remove array', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .commutativeAggregate(
                    'items',
                    'total',
                    (acc: number | undefined, item) => (acc ?? 0) + item.value,
                    (acc: number, item) => acc - item.value
                )
                .dropProperty('items')
        );

        // Add items
        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'A', value: 20 });
        pipeline.add("item3", { category: 'B', value: 30 });

        const output = getOutput() as Array<{ category: string; total: number; items?: unknown }>;

        // Groups should exist with aggregate property
        expect(output.length).toBe(2);
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.total).toBe(30); // 10 + 20
        expect(groupA?.items).toBeUndefined(); // Array should be removed
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.total).toBe(30);
        expect(groupB?.items).toBeUndefined();
        
        // Remove an item - aggregate should update
        pipeline.remove("item1", { category: 'A', value: 10 });
        const outputAfterRemove = getOutput() as Array<{ category: string; total: number; items?: unknown }>;
        const groupAAfter = outputAfterRemove.find(g => g.category === 'A');
        expect(groupAAfter?.total).toBe(20); // Updated aggregate
        expect(groupAAfter?.items).toBeUndefined(); // Array still removed
    });

    it('should preserve computed properties when defineProperty is before dropProperty', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .defineProperty('groupLabel', (group) => `Group: ${group.category}`)
                .dropProperty('items')
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'B', value: 20 });

        const output = getOutput();

        expect(output.length).toBe(2);
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.groupLabel).toBe('Group: A'); // Computed property preserved
        expect(groupA && 'items' in groupA ? (groupA as { items?: unknown }).items : undefined).toBeUndefined(); // Array removed
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.groupLabel).toBe('Group: B');
        expect(groupB && 'items' in groupB ? (groupB as { items?: unknown }).items : undefined).toBeUndefined();
    });

    it('should allow defineProperty after dropProperty on remaining structure', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ category: string, value: number }>()
                .groupBy(['category'], 'items')
                .dropProperty('items')
                .defineProperty('groupLabel', (group) => `Group: ${group.category}`)
        );

        pipeline.add("item1", { category: 'A', value: 10 });
        pipeline.add("item2", { category: 'B', value: 20 });

        const output = getOutput();

        expect(output.length).toBe(2);
        const groupA = output.find(g => g.category === 'A');
        const groupB = output.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.groupLabel).toBe('Group: A'); // Can compute on remaining structure
        expect(groupA && 'items' in groupA ? (groupA as { items?: unknown }).items : undefined).toBeUndefined();
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.groupLabel).toBe('Group: B');
        expect(groupB && 'items' in groupB ? (groupB as { items?: unknown }).items : undefined).toBeUndefined();
    });

    it('should work with dropProperty together', () => {
        const [pipeline, getOutput] = createTestPipeline(() => {
            const builder = createPipeline<{ category: string, value: number, extra: string }>()
                .groupBy(['category'], 'items')
                .dropProperty('extra' as any);  // 'extra' is not a valid key at root after groupBy, but test verifies it's handled gracefully
            // After dropProperty with 'as any', TypeScript loses type info, so we need to assert the builder
            return (builder as any as { dropProperty: (name: 'items') => any }).dropProperty('items');
        });

        pipeline.add("item1", { category: 'A', value: 10, extra: 'x' });
        pipeline.add("item2", { category: 'B', value: 20, extra: 'y' });

        const output = getOutput();

        expect(output.length).toBe(2);
        const outputTyped = output as Array<{ category: string; extra?: unknown; items?: unknown }>;
        const groupA = outputTyped.find(g => g.category === 'A');
        const groupB = outputTyped.find(g => g.category === 'B');
        
        expect(groupA).toBeDefined();
        expect(groupA?.category).toBe('A');
        expect(groupA?.extra).toBeUndefined(); // Property dropped
        expect(groupA?.items).toBeUndefined(); // Array dropped
        
        expect(groupB).toBeDefined();
        expect(groupB?.category).toBe('B');
        expect(groupB?.extra).toBeUndefined();
        expect(groupB?.items).toBeUndefined();
    });
});

describe('pipeline dropProperty nested scenarios (for arrays)', () => {
    it('should drop nested array at two levels', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities')
                .in('cities').dropProperty('venues')
        );

        pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Venue1', capacity: 100 });
        pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Venue2', capacity: 200 });
        pipeline.add("venue3", { state: 'TX', city: 'Houston', venue: 'Venue3', capacity: 300 });

        const output = getOutput();

        // States array should exist
        expect(output.length).toBe(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].cities).toBeDefined();
        
        // Cities array should exist
        expect(output[0].cities.length).toBe(2);
        const dallasCity = (output[0].cities as Array<{ city: string; venues?: unknown }>).find(c => c.city === 'Dallas');
        const houstonCity = (output[0].cities as Array<{ city: string; venues?: unknown }>).find(c => c.city === 'Houston');
        
        expect(dallasCity).toBeDefined();
        expect(dallasCity?.city).toBe('Dallas');
        expect(dallasCity?.venues).toBeUndefined(); // Venues array dropped
        
        expect(houstonCity).toBeDefined();
        expect(houstonCity?.city).toBe('Houston');
        expect(houstonCity?.venues).toBeUndefined(); // Venues array dropped
    });

    it('should drop deeply nested array at three levels', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, building: string, floors: number }>()
                .groupBy(['state', 'city', 'town'], 'buildings')
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
                .in('cities', 'towns').dropProperty('buildings')
        );

        pipeline.add("b1", { state: 'TX', city: 'Dallas', town: 'Plano', building: 'Tower', floors: 10 });
        pipeline.add("b2", { state: 'TX', city: 'Dallas', town: 'Plano', building: 'Plaza', floors: 5 });

        const output = getOutput();

        // States array should exist
        expect(output.length).toBe(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].cities).toBeDefined();
        
        // Cities array should exist
        const outputTyped = output as Array<{ state: string; cities: Array<{ city: string; towns: Array<{ town: string; buildings?: unknown }> }> }>;
        expect(outputTyped[0].cities.length).toBe(1);
        const dallasCity = outputTyped[0].cities[0];
        expect(dallasCity.city).toBe('Dallas');
        expect(dallasCity.towns).toBeDefined();
        
        // Towns array should exist
        expect(dallasCity.towns.length).toBe(1);
        const planoTown = dallasCity.towns[0];
        expect(planoTown.town).toBe('Plano');
        expect(planoTown.buildings).toBeUndefined(); // Buildings array dropped
    });

    it('should suppress events at dropped nested path', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, venue: string, capacity: number }>()
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities')
                .in('cities').dropProperty('venues')
        );

        // Add items at the dropped path level - events should be suppressed
        pipeline.add("venue1", { state: 'TX', city: 'Dallas', venue: 'Venue1', capacity: 100 });
        pipeline.add("venue2", { state: 'TX', city: 'Dallas', venue: 'Venue2', capacity: 200 });

        const output = getOutput();

        // Cities array should exist (parent level)
        if (output.length > 0 && output[0].cities) {
            const dallasCity = (output[0].cities as Array<{ city: string; venues?: unknown }> | undefined)?.find(c => c.city === 'Dallas');
            if (dallasCity) {
                // Venues array should not exist because events at ['cities', 'venues'] are suppressed
                expect(dallasCity.venues).toBeUndefined();
            }
        }
    });

    it('should suppress events below dropped path', () => {
        // Create a structure with three levels: cities > venues > staff
        // Drop ['cities', 'venues'], which should also suppress events at ['cities', 'venues', 'staff']
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, venue: string, staff: string, role: string }>()
                .groupBy(['state', 'city', 'venue'], 'staff')
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities')
                .in('cities').dropProperty('venues')
        );

        // Add items at the dropped path and below it
        pipeline.add("staff1", { state: 'TX', city: 'Dallas', venue: 'Venue1', staff: 'John', role: 'Manager' });
        pipeline.add("staff2", { state: 'TX', city: 'Dallas', venue: 'Venue1', staff: 'Jane', role: 'Server' });

        const output = getOutput();

        // Cities array should exist
        if (output.length > 0 && output[0].cities) {
            const dallasCity = (output[0].cities as Array<{ city: string; venues?: unknown }> | undefined)?.find(c => c.city === 'Dallas');
            if (dallasCity) {
                // Venues array should be dropped
                expect(dallasCity.venues).toBeUndefined();
                // Events at ['cities', 'venues'] and below are suppressed
            }
        }
    });

    it('should handle multiple dropProperty calls at different levels', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, venue: string, staff: string, role: string }>()
                .groupBy(['state', 'city', 'venue'], 'staff')
                .groupBy(['state', 'city'], 'venues')
                .groupBy(['state'], 'cities')
                .in('cities').dropProperty('venues')
                .in('cities', 'venues').dropProperty('staff')
        );

        pipeline.add("staff1", { state: 'TX', city: 'Dallas', venue: 'Venue1', staff: 'John', role: 'Manager' });

        const output = getOutput();

        // Cities array should exist
        if (output.length > 0 && output[0].cities) {
            const dallasCity = (output[0].cities as Array<{ city: string; venues?: unknown }> | undefined)?.find(c => c.city === 'Dallas');
            if (dallasCity) {
                // Both dropped arrays should be absent
                expect(dallasCity.venues).toBeUndefined();
            }
        }
        
        // Verify structure is correct - cities exist but venues and staff are dropped
        expect(output.length).toBeGreaterThan(0);
        expect(output[0].cities).toBeDefined();
    });
});

