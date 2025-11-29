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
});