import { createPipeline } from "../index";
import { createTestPipeline } from "./helpers";

describe('pipeline groupBy nested', () => {
    it('should group by nested key property', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        pipeline.add("town1", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        pipeline.add("town2", { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 });
        pipeline.add("town3", { state: 'TX', city: 'Dallas', town: 'Carrollton', population: 3000000 });
        pipeline.add("town4", { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 });
        pipeline.add("town5", { state: 'TX', city: 'Houston', town: 'Katy', population: 6000000 });
        pipeline.add("town6", { state: 'TX', city: 'Houston', town: 'Sugar Land', population: 7000000 });
        pipeline.add("town7", { state: 'OK', city: 'Oklahoma City', town: 'Oklahoma City', population: 9000000 });
        pipeline.add("town8", { state: 'OK', city: 'Oklahoma City', town: 'Edmond', population: 10000000 });
        pipeline.add("town9", { state: 'OK', city: 'Tulsa', town: 'Tulsa', population: 10000000 });
        pipeline.add("town10", { state: 'OK', city: 'Tulsa', town: 'Broken Arrow', population: 11000000 });
        pipeline.add("town11", { state: 'OK', city: 'Tulsa', town: 'Jenks', population: 13000000 });

        const output = getOutput();
        expect(output.length).toBe(2);
        expect(output[0].state).toBe('TX');
        expect(output[0].cities).toEqual([
            {
                city: 'Dallas',
                towns: [
                    { town: 'Plano', population: 1000000 },
                    { town: 'Richardson', population: 2000000 },
                    { town: 'Carrollton', population: 3000000 }
                ]
            },
            {
                city: 'Houston',
                towns: [
                    { town: 'Houston', population: 5000000 },
                    { town: 'Katy', population: 6000000 },
                    { town: 'Sugar Land', population: 7000000 }
                ]
            },
        ]);
        expect(output[1].state).toBe('OK');
        expect(output[1].cities).toEqual([
            {
                city: 'Oklahoma City',
                towns: [
                    { town: 'Oklahoma City', population: 9000000 },
                    { town: 'Edmond', population: 10000000 }
                ]
            },
            {
                city: 'Tulsa',
                towns: [
                    { town: 'Tulsa', population: 10000000 },
                    { town: 'Broken Arrow', population: 11000000 },
                    { town: 'Jenks', population: 13000000 }
                ]
            }
        ]);
    });

    it('should handle single item per nested group', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        pipeline.add("town1", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        pipeline.add("town2", { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 });
        
        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].cities).toHaveLength(2);
        expect(output[0].cities[0].towns).toHaveLength(1);
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
        expect(output[0].cities[1].towns).toHaveLength(1);
        expect(output[0].cities[1].towns[0].town).toBe('Houston');
    });

    it('should handle items added to existing nested groups', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        // Add first town - creates city group
        pipeline.add("town1", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        
        let output = getOutput();
        expect(output[0].cities[0].towns).toHaveLength(1);
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
        
        // Add second town to same city - should update existing city group
        pipeline.add("town2", { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 });
        
        output = getOutput();
        expect(output[0].cities[0].towns).toHaveLength(2);
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
        expect(output[0].cities[0].towns[1].town).toBe('Richardson');
    });

    it('should remove items from nested groups', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        const town1 = { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 };
        const town2 = { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 };
        pipeline.add("town1", town1);
        pipeline.add("town2", town2);
        
        expect(getOutput()[0].cities[0].towns).toHaveLength(2);
        
        pipeline.remove("town2", town2);
        
        const output = getOutput();
        expect(output[0].cities[0].towns).toHaveLength(1);
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
    });

    it('should remove nested group when all items are removed', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        // Add multiple towns to Dallas (to deplete it later)
        const town1 = { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 };
        const town2 = { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 };
        // Add a town to Houston (to keep it around)
        const town3 = { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 };
        pipeline.add("town1", town1);
        pipeline.add("town2", town2);
        pipeline.add("town3", town3);
        
        expect(getOutput()[0].cities).toHaveLength(2);
        
        // Remove all towns from Dallas to deplete the Dallas city group
        pipeline.remove("town1", town1);
        pipeline.remove("town2", town2);
        
        const output = getOutput();
        // Dallas city group should be removed, Houston should remain
        expect(output[0].cities).toHaveLength(1);
        expect(output[0].cities[0].city).toBe('Houston');
    });

    it('should handle different numbers of nested groups per parent', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        // TX has 2 cities
        pipeline.add("town1", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        pipeline.add("town2", { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 });
        
        // OK has 1 city
        pipeline.add("town3", { state: 'OK', city: 'Tulsa', town: 'Tulsa', population: 10000000 });
        
        const output = getOutput();
        expect(output.length).toBe(2);
        
        const txState = output.find(s => s.state === 'TX');
        const okState = output.find(s => s.state === 'OK');
        
        expect(txState).toBeDefined();
        expect(txState?.cities).toHaveLength(2);
        expect(okState).toBeDefined();
        expect(okState?.cities).toHaveLength(1);
    });

    it('should preserve order of items in nested groups', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        const towns = [
            { key: "town1", data: { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 } },
            { key: "town2", data: { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 } },
            { key: "town3", data: { state: 'TX', city: 'Dallas', town: 'Carrollton', population: 3000000 } }
        ];
        
        towns.forEach(t => pipeline.add(t.key, t.data));
        
        const output = getOutput();
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
        expect(output[0].cities[0].towns[1].town).toBe('Richardson');
        expect(output[0].cities[0].towns[2].town).toBe('Carrollton');
    });

    it('should remove parent group when all nested groups are removed', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        const town1 = { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 };
        const town2 = { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 };
        pipeline.add("town1", town1);
        pipeline.add("town2", town2);
        
        expect(getOutput().length).toBe(1);
        expect(getOutput()[0].cities).toHaveLength(2);
        
        pipeline.remove("town1", town1);
        pipeline.remove("town2", town2);
        
        const output = getOutput();
        expect(output.length).toBe(0);
    });

    it('should work with defineProperty before nested groupBy', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .defineProperty('formatted', (item) => `${item.city}, ${item.state}`)
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        pipeline.add("town1", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        
        const output = getOutput();
        expect(output[0].cities[0].towns[0].formatted).toBe('Dallas, TX');
    });

    it('should handle three-level nested grouping', () => {
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, building: string, floors: number }>()
                .groupBy(['state', 'city', 'town'], 'buildings')
                .groupBy(['state', 'city'], 'towns')
                .groupBy(['state'], 'cities')
        );

        pipeline.add("b1", { state: 'TX', city: 'Dallas', town: 'Plano', building: 'Tower', floors: 10 });
        pipeline.add("b2", { state: 'TX', city: 'Dallas', town: 'Plano', building: 'Plaza', floors: 5 });
        
        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].cities).toHaveLength(1);
        expect(output[0].cities[0].city).toBe('Dallas');
        expect(output[0].cities[0].towns).toHaveLength(1);
        expect(output[0].cities[0].towns[0].town).toBe('Plano');
        expect(output[0].cities[0].towns[0].buildings).toHaveLength(2);
        expect(output[0].cities[0].towns[0].buildings[0].building).toBe('Tower');
        expect(output[0].cities[0].towns[0].buildings[1].building).toBe('Plaza');
    });

    it('should handle nested groupBy with scoped .in() pattern used by desktop app', () => {
        // This test reproduces the pattern used by the desktop app's pipelineRunner:
        // .groupBy(['state'], 'byState')
        // .in('byState').groupBy(['city'], 'byCity')
        // 
        // This creates a different handler registration order than consecutive groupBy calls
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state'], 'byState')
                .in('byState').groupBy(['city'], 'byCity')
        );

        // Add rows incrementally as the CSV parser would
        pipeline.add("row-0", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        pipeline.add("row-1", { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 });
        pipeline.add("row-2", { state: 'OK', city: 'Tulsa', town: 'Tulsa', population: 3000000 });
        
        const output = getOutput();
        expect(output.length).toBe(2);
        
        const txState = output.find(s => s.state === 'TX');
        expect(txState).toBeDefined();
        expect(txState?.byState).toHaveLength(2);
    });

    it('should handle three-level nested groupBy with scoped .in() pattern', () => {
        // This is the deeper nesting pattern that may trigger the ordering bug:
        // First groupBy creates byState array
        // Second groupBy (scoped to byState) creates byCity within each state
        // Third groupBy (scoped to byState.byCity) creates byTown within each city
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, building: string, floors: number }>()
                .groupBy(['state'], 'byState')
                .in('byState').groupBy(['city'], 'byCity')
                .in('byState', 'byCity').groupBy(['town'], 'byTown')
        );

        // Add first row - creates all three levels
        pipeline.add("row-0", { state: 'TX', city: 'Dallas', town: 'Plano', building: 'Tower', floors: 10 });
        
        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].state).toBe('TX');
        expect(output[0].byState).toHaveLength(1);
        expect(output[0].byState[0].city).toBe('Dallas');
        expect(output[0].byState[0].byCity).toHaveLength(1);
        expect(output[0].byState[0].byCity[0].town).toBe('Plano');
        expect(output[0].byState[0].byCity[0].byTown).toHaveLength(1);
        expect(output[0].byState[0].byCity[0].byTown[0].building).toBe('Tower');
    });

    it('should handle incremental rows creating new nested groups in existing parents with .in() pattern', () => {
        // This test specifically targets the scenario where:
        // 1. A parent group already exists
        // 2. A new row creates a new child group within that parent
        // 3. The child's item handler might fire before proper state updates
        const [pipeline, getOutput] = createTestPipeline(() => 
            createPipeline<{ state: string, city: string, town: string, population: number }>()
                .groupBy(['state'], 'byState')
                .in('byState').groupBy(['city'], 'byCity')
                .in('byState', 'byCity').groupBy(['town'], 'byTown')
        );

        // Row 1: Creates TX -> Dallas -> Plano hierarchy
        pipeline.add("row-0", { state: 'TX', city: 'Dallas', town: 'Plano', population: 1000000 });
        
        // Row 2: Same state, same city, new town - should add town to existing city
        pipeline.add("row-1", { state: 'TX', city: 'Dallas', town: 'Richardson', population: 2000000 });
        
        // Row 3: Same state, NEW city, new town - this triggers creation of new city group
        // within existing state, which may cause the ordering issue
        pipeline.add("row-2", { state: 'TX', city: 'Houston', town: 'Houston', population: 5000000 });
        
        // Row 4: NEW state - this creates entirely new state -> city -> town hierarchy
        pipeline.add("row-3", { state: 'OK', city: 'Tulsa', town: 'Tulsa', population: 3000000 });
        
        const output = getOutput();
        expect(output.length).toBe(2);
        
        const txState = output.find(s => s.state === 'TX');
        expect(txState).toBeDefined();
        expect(txState?.byState).toHaveLength(2);
        
        const dallas = txState?.byState.find((c: any) => c.city === 'Dallas');
        expect(dallas).toBeDefined();
        expect(dallas?.byCity).toHaveLength(2);
        
        const houston = txState?.byState.find((c: any) => c.city === 'Houston');
        expect(houston).toBeDefined();
        expect(houston?.byCity).toHaveLength(1);
    });

    it('should handle four levels of consecutive groupBy at same scope', () => {
        // This tests the isBelowItemLevel interceptor with deep nesting
        // Using consecutive groupBy calls (NOT using .in()) which triggers
        // the interceptor pattern for deeper paths
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ a: string, b: string, c: string, d: string, value: number }>()
                .groupBy(['a', 'b', 'c', 'd'], 'leaves')
                .groupBy(['a', 'b', 'c'], 'level3')
                .groupBy(['a', 'b'], 'level2')
                .groupBy(['a'], 'level1')
        );

        // Add data that creates the full hierarchy
        pipeline.add("row-0", { a: 'A1', b: 'B1', c: 'C1', d: 'D1', value: 1 });
        pipeline.add("row-1", { a: 'A1', b: 'B1', c: 'C1', d: 'D2', value: 2 });
        pipeline.add("row-2", { a: 'A1', b: 'B1', c: 'C2', d: 'D1', value: 3 });
        pipeline.add("row-3", { a: 'A1', b: 'B2', c: 'C1', d: 'D1', value: 4 });
        pipeline.add("row-4", { a: 'A2', b: 'B1', c: 'C1', d: 'D1', value: 5 });

        const output = getOutput();
        expect(output.length).toBe(2);
        
        const a1 = output.find(x => x.a === 'A1');
        expect(a1?.level1).toHaveLength(2); // B1, B2
        
        // Navigate to A1 -> B1 -> level2
        const a1b1 = a1?.level1.find((x: any) => x.b === 'B1');
        expect(a1b1?.level2).toHaveLength(2); // C1, C2
        
        // Navigate to A1 -> B1 -> C1 -> level3
        const a1b1c1 = a1b1?.level2.find((x: any) => x.c === 'C1');
        expect(a1b1c1?.level3).toHaveLength(2); // D1, D2
    });

    it('should handle interleaved data creating new groups at different levels', () => {
        // This test adds data in a specific order that might expose ordering issues:
        // - First create a deep hierarchy
        // - Then add data that creates new groups at intermediate levels
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ region: string, country: string, city: string, store: string }>()
                .groupBy(['region', 'country', 'city'], 'stores')
                .groupBy(['region', 'country'], 'cities')
                .groupBy(['region'], 'countries')
        );

        // Create first full hierarchy: Americas -> USA -> NYC -> Store1
        pipeline.add("row-0", { region: 'Americas', country: 'USA', city: 'NYC', store: 'Store1' });
        
        // Add to existing deepest level: Americas -> USA -> NYC -> Store2
        pipeline.add("row-1", { region: 'Americas', country: 'USA', city: 'NYC', store: 'Store2' });
        
        // Create new at second level: Americas -> USA -> LA -> Store3
        pipeline.add("row-2", { region: 'Americas', country: 'USA', city: 'LA', store: 'Store3' });
        
        // Create new at first level: Americas -> Canada -> Toronto -> Store4
        pipeline.add("row-3", { region: 'Americas', country: 'Canada', city: 'Toronto', store: 'Store4' });
        
        // Create entirely new region: Europe -> UK -> London -> Store5
        pipeline.add("row-4", { region: 'Europe', country: 'UK', city: 'London', store: 'Store5' });
        
        // Go back to first region, add new country: Americas -> Mexico -> CDMX -> Store6
        pipeline.add("row-5", { region: 'Americas', country: 'Mexico', city: 'CDMX', store: 'Store6' });

        const output = getOutput();
        expect(output.length).toBe(2);
        
        const americas = output.find(r => r.region === 'Americas');
        expect(americas?.countries).toHaveLength(3); // USA, Canada, Mexico
        
        const usa = americas?.countries.find((c: any) => c.country === 'USA');
        expect(usa?.cities).toHaveLength(2); // NYC, LA
        
        const nyc = usa?.cities.find((city: any) => city.city === 'NYC');
        expect(nyc?.stores).toHaveLength(2); // Store1, Store2
    });

    it('should handle rapid additions that create many groups simultaneously', () => {
        // Stress test: add many rows quickly creating various group combinations
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ cat: string, subcat: string, item: string }>()
                .groupBy(['cat', 'subcat'], 'items')
                .groupBy(['cat'], 'subcats')
        );

        // Generate test data with many combinations
        const categories = ['A', 'B', 'C', 'D'];
        const subcategories = ['X', 'Y', 'Z'];
        
        let rowIndex = 0;
        // Add items in a pattern that jumps between categories
        for (let i = 0; i < 3; i++) {
            for (const cat of categories) {
                for (const subcat of subcategories) {
                    pipeline.add(`row-${rowIndex}`, {
                        cat,
                        subcat,
                        item: `Item-${cat}-${subcat}-${i}`
                    });
                    rowIndex++;
                }
            }
        }

        const output = getOutput();
        expect(output.length).toBe(4); // 4 categories
        
        for (const category of output) {
            expect(category.subcats).toHaveLength(3); // 3 subcategories each
            for (const subcat of category.subcats) {
                expect(subcat.items).toHaveLength(3); // 3 items each
            }
        }
    });

    it('should handle chained .in() calls (desktop app pattern)', () => {
        // The desktop app builds scopes by calling .in() multiple times in a loop:
        // for (const segment of scopePath) {
        //   scopedBuilder = scopedBuilder.in(segment);
        // }
        // This test verifies that chained .in() calls work correctly
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ a: string, b: string, c: string, value: number }>()
                .groupBy(['a'], 'level1')
                .in('level1').groupBy(['b'], 'level2')
                .in('level1').in('level2').groupBy(['c'], 'level3')
        );

        pipeline.add("row-0", { a: 'A1', b: 'B1', c: 'C1', value: 1 });
        pipeline.add("row-1", { a: 'A1', b: 'B1', c: 'C2', value: 2 });
        pipeline.add("row-2", { a: 'A1', b: 'B2', c: 'C1', value: 3 });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].a).toBe('A1');
        expect(output[0].level1).toHaveLength(2); // B1, B2
        expect(output[0].level1[0].level2).toHaveLength(2); // C1, C2 under B1
        expect(output[0].level1[1].level2).toHaveLength(1); // C1 under B2
    });

    it('should handle two-level groupBy with completely different properties', () => {
        // This test replicates the exact user scenario from the bug report:
        // - Data has fields: userHash, round, allocation, createdAt, receivedAt
        // - First groupBy: `userHash` → `rounts` (at root level)
        // - Second groupBy: `round` → `allocations` (inside rounts)
        //
        // The KEY DIFFERENCE from other tests: the first and second groupBy use
        // COMPLETELY DIFFERENT properties (userHash vs round), not overlapping
        // key hierarchies (like state, city where city includes state).
        //
        // Error expected: "Path references unknown item when setting state"
        type UserAllocationRow = {
            userHash: string;
            round: number;
            allocation: string;
            createdAt: string;
            receivedAt: string;
        };

        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<UserAllocationRow>()
                .groupBy(['userHash'], 'rounts')
                .in('rounts').groupBy(['round'], 'allocations')
        );

        // Add rows incrementally as the CSV parser would
        // Row 1: Creates userHash group, then round group within it
        pipeline.add("row-0", {
            userHash: 'hash1',
            round: 1,
            allocation: '[0,0,0,0,10000,0]',
            createdAt: '2025-06-25T23:59:56.688Z',
            receivedAt: '2025-06-25T23:59:56.874Z'
        });

        // Row 2: Same userHash, different round - creates new round group in existing userHash
        pipeline.add("row-1", {
            userHash: 'hash1',
            round: 2,
            allocation: '[0,0,0,0,20000,0]',
            createdAt: '2025-06-26T00:00:00.000Z',
            receivedAt: '2025-06-26T00:00:00.100Z'
        });

        // Row 3: Different userHash - creates new userHash group with new round group
        pipeline.add("row-2", {
            userHash: 'hash2',
            round: 1,
            allocation: '[0,0,0,0,15000,0]',
            createdAt: '2025-06-25T23:59:57.000Z',
            receivedAt: '2025-06-25T23:59:57.200Z'
        });

        const output = getOutput();
        expect(output.length).toBe(2);

        const hash1 = output.find(u => u.userHash === 'hash1');
        expect(hash1).toBeDefined();
        expect(hash1?.rounts).toHaveLength(2);

        const hash1Round1 = hash1?.rounts.find((r: any) => r.round === 1);
        expect(hash1Round1).toBeDefined();
        expect(hash1Round1?.allocations).toHaveLength(1);

        const hash1Round2 = hash1?.rounts.find((r: any) => r.round === 2);
        expect(hash1Round2).toBeDefined();
        expect(hash1Round2?.allocations).toHaveLength(1);

        const hash2 = output.find(u => u.userHash === 'hash2');
        expect(hash2).toBeDefined();
        expect(hash2?.rounts).toHaveLength(1);
    });

    it('should handle two-level groupBy with string values (CSV input simulation)', () => {
        // This test simulates CSV input where ALL values are strings
        // This matches exactly what the desktop app's pipelineRunner receives
        // The groupBy operations use different properties at each level:
        // Level 1: userHash (string)
        // Level 2: round (string, not number!)
        //
        // Error expected: "Path references unknown item when setting state"
        type CsvRow = Record<string, string>;

        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CsvRow>()
                .groupBy(['userHash'], 'rounts')
                .in('rounts').groupBy(['round'], 'allocations')
        );

        // Simulate CSV streaming - each row arrives individually
        // Row 1: Creates userHash='hash1' group, then round='1' group within it
        pipeline.add("row-0", {
            userHash: 'hash1',
            round: '1',  // String, not number!
            allocation: '[0,0,0,0,10000,0]',
            createdAt: '2025-06-25T23:59:56.688Z',
            receivedAt: '2025-06-25T23:59:56.874Z'
        });

        // Row 2: Same userHash, different round (as string) - creates new round group
        pipeline.add("row-1", {
            userHash: 'hash1',
            round: '2',  // Different round
            allocation: '[0,0,0,0,20000,0]',
            createdAt: '2025-06-26T00:00:00.000Z',
            receivedAt: '2025-06-26T00:00:00.100Z'
        });

        // Row 3: Different userHash - creates new userHash group with new round group
        pipeline.add("row-2", {
            userHash: 'hash2',
            round: '1',
            allocation: '[0,0,0,0,15000,0]',
            createdAt: '2025-06-25T23:59:57.000Z',
            receivedAt: '2025-06-25T23:59:57.200Z'
        });

        const output = getOutput();
        expect(output.length).toBe(2);

        const hash1 = output.find((u: any) => u.userHash === 'hash1');
        expect(hash1).toBeDefined();
        expect(hash1?.rounts).toHaveLength(2);

        const hash1Round1 = hash1?.rounts.find((r: any) => r.round === '1');
        expect(hash1Round1).toBeDefined();
        expect(hash1Round1?.allocations).toHaveLength(1);

        const hash2 = output.find((u: any) => u.userHash === 'hash2');
        expect(hash2).toBeDefined();
        expect(hash2?.rounts).toHaveLength(1);
    });

    it('should handle chained .in() calls building scope iteratively (desktop app pattern)', () => {
        // The desktop app builds scope by calling .in() in a loop:
        // let scopedBuilder = builder;
        // for (const segment of step.scopePath) {
        //   scopedBuilder = scopedBuilder.in(segment);
        // }
        // This test verifies this pattern works correctly
        type CsvRow = Record<string, string>;
        
        const [pipeline, getOutput] = createTestPipeline(() => {
            // Simulate the desktop app's step building pattern
            let builder: any = createPipeline<CsvRow>()
                .groupBy(['userHash'], 'rounts');
            
            // Step 2: iterate through scopePath=['rounts']
            let scopedBuilder = builder;
            for (const segment of ['rounts']) {
                scopedBuilder = scopedBuilder.in(segment);
            }
            return scopedBuilder.groupBy(['round'], 'allocations');
        });

        // Add rows
        pipeline.add("row-0", { userHash: 'hash1', round: '1', value: '100' });
        pipeline.add("row-1", { userHash: 'hash1', round: '2', value: '200' });
        pipeline.add("row-2", { userHash: 'hash2', round: '1', value: '300' });

        const output = getOutput() as any[];
        expect(output.length).toBe(2);
        expect(output.find((u: any) => u.userHash === 'hash1')?.rounts).toHaveLength(2);
    });

    it('should handle multiple items in same nested group (rapid sequential adds)', () => {
        // This tests the scenario where multiple rows with the SAME grouping values
        // are added rapidly. Each row should be added to the existing nested group.
        // Error possible: "Path references unknown item when setting state" if
        // handler ordering causes items to be added before their parent group exists.
        type CsvRow = Record<string, string>;

        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CsvRow>()
                .groupBy(['userHash'], 'rounts')
                .in('rounts').groupBy(['round'], 'allocations')
        );

        // Add multiple rows with SAME userHash and SAME round
        // This should create one userHash group with one round group containing multiple items
        pipeline.add("row-0", {
            userHash: 'hash1',
            round: '1',
            allocation: '[0,0,0,0,10000,0]',
            createdAt: '2025-06-25T23:59:56.688Z'
        });
        pipeline.add("row-1", {
            userHash: 'hash1',
            round: '1',  // SAME round
            allocation: '[0,0,0,0,20000,0]',
            createdAt: '2025-06-25T23:59:57.000Z'
        });
        pipeline.add("row-2", {
            userHash: 'hash1',
            round: '1',  // SAME round again
            allocation: '[0,0,0,0,30000,0]',
            createdAt: '2025-06-25T23:59:58.000Z'
        });

        const output = getOutput();
        expect(output.length).toBe(1);
        expect(output[0].userHash).toBe('hash1');
        expect(output[0].rounts).toHaveLength(1);
        expect(output[0].rounts[0].round).toBe('1');
        expect(output[0].rounts[0].allocations).toHaveLength(3);
    });

    it('should handle interleaved rows creating nested groups in different order', () => {
        // This tests a more complex data pattern where rows arrive in a specific order
        // that may expose handler chain timing issues:
        // 1. hash1/round1 - creates both levels
        // 2. hash2/round1 - creates new top level, reuses round value
        // 3. hash1/round2 - reuses top level, creates new nested
        // 4. hash2/round2 - reuses top level, creates new nested
        type CsvRow = Record<string, string>;

        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CsvRow>()
                .groupBy(['userHash'], 'rounts')
                .in('rounts').groupBy(['round'], 'allocations')
        );

        // Interleaved pattern
        pipeline.add("row-0", { userHash: 'hash1', round: '1', value: 'A' });
        pipeline.add("row-1", { userHash: 'hash2', round: '1', value: 'B' });
        pipeline.add("row-2", { userHash: 'hash1', round: '2', value: 'C' });
        pipeline.add("row-3", { userHash: 'hash2', round: '2', value: 'D' });
        pipeline.add("row-4", { userHash: 'hash1', round: '1', value: 'E' });  // Back to existing

        const output = getOutput();
        expect(output.length).toBe(2);

        const hash1 = output.find((u: any) => u.userHash === 'hash1');
        expect(hash1?.rounts).toHaveLength(2);
        const hash1Round1 = hash1?.rounts.find((r: any) => r.round === '1');
        expect(hash1Round1?.allocations).toHaveLength(2);  // row-0 and row-4

        const hash2 = output.find((u: any) => u.userHash === 'hash2');
        expect(hash2?.rounts).toHaveLength(2);
    });
});