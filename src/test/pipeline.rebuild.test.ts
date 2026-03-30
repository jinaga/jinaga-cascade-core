import { createPipeline, KeyedArray, toPipelinePlainOutput, Transform } from '../index';

function simulateState<T>(initialState: T): [() => T, (transform: Transform<T>) => void] {
    let state: T = initialState;
    return [
        () => state,
        (transform: Transform<T>) => state = transform(state)
    ];
}

describe('pipeline rebuild from same builder', () => {
    it('should produce output when second session adds rows with same group keys as first session', () => {
        // Given: a pipeline builder with groupBy
        const builder = createPipeline<{ category: string; value: number }>()
            .groupBy(['category'], 'items');
        const typeDescriptor = builder.getTypeDescriptor();

        // Build session 1 and add data
        const [getState1, setState1] = simulateState<KeyedArray<any>>([]);
        const session1 = builder.build(setState1);
        session1.add('item1', { category: 'A', value: 10 });
        session1.add('item2', { category: 'B', value: 20 });
        session1.flush();

        const output1 = toPipelinePlainOutput(getState1(), typeDescriptor) as any[];
        expect(output1).toHaveLength(2);

        // Dispose session 1
        session1.dispose();

        // When: build session 2 from the same builder and add rows with the same group keys
        const [getState2, setState2] = simulateState<KeyedArray<any>>([]);
        const session2 = builder.build(setState2);
        session2.add('item3', { category: 'A', value: 30 });
        session2.add('item4', { category: 'B', value: 40 });
        session2.flush();

        // Then: session 2 should produce output
        const output2 = toPipelinePlainOutput(getState2(), typeDescriptor) as any[];
        expect(output2).toHaveLength(2);
        expect(output2.find((g: any) => g.category === 'A')?.items).toEqual([{ value: 30 }]);
        expect(output2.find((g: any) => g.category === 'B')?.items).toEqual([{ value: 40 }]);
    });

    it('should produce output when second session adds rows with same group keys — groupBy + sum + dropProperty', () => {
        // Given: a pipeline closer to the bug report shape
        const builder = createPipeline<{ entityId: string; value: number }, 'items'>('items')
            .groupBy(['entityId'], 'groups')
            .sum('items', 'value', 'total')
            .dropProperty('items');
        const typeDescriptor = builder.getTypeDescriptor();

        // Build session 1
        const [getState1, setState1] = simulateState<KeyedArray<any>>([]);
        const session1 = builder.build(setState1);
        session1.add('r1', { entityId: 'A', value: 100 });
        session1.add('r2', { entityId: 'B', value: 200 });
        session1.flush();

        const output1 = toPipelinePlainOutput(getState1(), typeDescriptor) as any[];
        expect(output1).toHaveLength(2);
        expect(output1.find((g: any) => g.entityId === 'A')?.total).toBe(100);

        // Dispose session 1
        session1.dispose();

        // When: build session 2 with same group keys
        const [getState2, setState2] = simulateState<KeyedArray<any>>([]);
        const session2 = builder.build(setState2);
        session2.add('r1', { entityId: 'A', value: 300 });
        session2.add('r2', { entityId: 'B', value: 400 });
        session2.flush();

        // Then: session 2 should produce output with new values
        const output2 = toPipelinePlainOutput(getState2(), typeDescriptor) as any[];
        expect(output2).toHaveLength(2);
        expect(output2.find((g: any) => g.entityId === 'A')?.total).toBe(300);
        expect(output2.find((g: any) => g.entityId === 'B')?.total).toBe(400);
    });

    it('should not leak aggregate state from first build into second build', () => {
        const builder = createPipeline<{ entityId: string; value: number }, 'items'>('items')
            .groupBy(['entityId'], 'groups')
            .sum('items', 'value', 'total')
            .dropProperty('items');
        const typeDescriptor = builder.getTypeDescriptor();

        const [getState1, setState1] = simulateState<KeyedArray<any>>([]);
        const session1 = builder.build(setState1);
        session1.add('r1', { entityId: 'A', value: 100 });
        session1.add('r2', { entityId: 'A', value: 50 });
        session1.add('r3', { entityId: 'B', value: 75 });
        session1.flush();

        const output1 = toPipelinePlainOutput(getState1(), typeDescriptor) as any[];
        expect(output1).toEqual(
            expect.arrayContaining([
                { entityId: 'A', total: 150 },
                { entityId: 'B', total: 75 }
            ])
        );

        session1.dispose();

        const [getState2, setState2] = simulateState<KeyedArray<any>>([]);
        const session2 = builder.build(setState2);
        session2.add('r4', { entityId: 'A', value: 7 });
        session2.add('r5', { entityId: 'B', value: 3 });
        session2.flush();

        const output2 = toPipelinePlainOutput(getState2(), typeDescriptor) as any[];
        expect(output2).toHaveLength(2);
        expect(output2).toEqual(
            expect.arrayContaining([
                { entityId: 'A', total: 7 },
                { entityId: 'B', total: 3 }
            ])
        );
        expect(output2).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ entityId: 'A', total: 157 }),
                expect.objectContaining({ entityId: 'B', total: 78 })
            ])
        );
    });

    it('should produce output when second session uses enrich with empty source', () => {
        // Given: a pipeline with groupBy + enrich + dropProperty (matches bug report pattern)
        const classPipeline = createPipeline<{ entityId: string; flag: number }, 'classes'>('classes')
            .groupBy(['entityId'], 'byEntity')
            .max('classes', 'flag', 'maxFlag')
            .dropProperty('classes');

        const builder = createPipeline<{ id: string; entityId: string; value: number }, 'items'>('items')
            .groupBy(['entityId'], 'groups')
            .sum('items', 'value', 'total')
            .enrich('classSource', classPipeline, ['entityId'] as const, 'classInfo', {
                entityId: '',
                maxFlag: 0,
            })
            .dropProperty('items');
        const typeDescriptor = builder.getTypeDescriptor();

        // Build session 1 — populate enrichment source
        const [getState1, setState1] = simulateState<KeyedArray<any>>([]);
        const session1 = builder.build(setState1);
        const source1 = (session1 as any).sources.classSource;
        source1.add('c-A', { entityId: 'A', flag: 1 });
        session1.add('r1', { id: 'r1', entityId: 'A', value: 100 });
        session1.add('r2', { id: 'r2', entityId: 'B', value: 200 });
        session1.flush();

        const output1 = toPipelinePlainOutput(getState1(), typeDescriptor) as any[];
        expect(output1).toHaveLength(2);

        // Dispose session 1
        session1.dispose();

        // When: build session 2, enrichment source NOT populated
        const [getState2, setState2] = simulateState<KeyedArray<any>>([]);
        const session2 = builder.build(setState2);
        session2.add('r1', { id: 'r1', entityId: 'A', value: 300 });
        session2.add('r2', { id: 'r2', entityId: 'B', value: 400 });
        session2.flush();

        // Then: session 2 should produce output with whenMissing default
        const output2 = toPipelinePlainOutput(getState2(), typeDescriptor) as any[];
        expect(output2).toHaveLength(2);
        expect(output2).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    entityId: 'A',
                    total: 300,
                    classInfo: {
                        entityId: '',
                        maxFlag: 0
                    }
                }),
                expect.objectContaining({
                    entityId: 'B',
                    total: 400,
                    classInfo: {
                        entityId: '',
                        maxFlag: 0
                    }
                })
            ])
        );
    });
});
