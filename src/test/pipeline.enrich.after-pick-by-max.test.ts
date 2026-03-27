import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

/**
 * Regression: vote / class split style pipelines use groupBy → pickByMax → enrich(secondary).
 * Secondary rows often arrive after primary allocation rows (separate Jinaga subscribe).
 * This test locks in reactive enrich after pickByMax when sources.attendeeClasses.add runs last.
 */
describe('enrich after pickByMax (secondary joins after primary)', () => {
    interface AllocationRow {
        attendeePublicKey: string;
        attendeeEventId: string;
        createdAt: string;
        votes: number;
    }

    interface ClassRow {
        attendeeEventId: string;
        investorFlag: number;
    }

    const whenMissing = {
        attendeeEventId: '',
        attendeeClasses: [] as { key: string; value: { investorFlag: number } }[]
    };

    it('updates classInfo from whenMissing after late secondary add (same join key as groupBy scalars)', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<AllocationRow, 'allocations'>('allocations')
                .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')
                .pickByMax('allocations', 'createdAt', 'latestAllocation')
                .enrich(
                    'attendeeClasses',
                    createPipeline<ClassRow, 'attendeeClasses'>('attendeeClasses').groupBy(
                        ['attendeeEventId'],
                        'attendeeClasses'
                    ),
                    ['attendeeEventId'],
                    'classInfo',
                    whenMissing
                )
        );

        pipeline.add('alloc-1', {
            attendeePublicKey: 'pk-a',
            attendeeEventId: 'ev-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            votes: 10
        });
        pipeline.add('alloc-2', {
            attendeePublicKey: 'pk-b',
            attendeeEventId: 'ev-1',
            createdAt: '2026-01-02T00:00:00.000Z',
            votes: 20
        });

        let rows = getOutput();
        expect(rows).toHaveLength(2);
        expect(
            rows.every(
                r =>
                    r.classInfo.attendeeEventId === '' && r.classInfo.attendeeClasses.length === 0
            )
        ).toBe(true);

        const sources = (pipeline as unknown as {
            sources: { attendeeClasses: { add: (key: string, immutableProps: ClassRow) => void } };
        }).sources;

        sources.attendeeClasses.add('class-ev-1', { attendeeEventId: 'ev-1', investorFlag: 1 });

        rows = getOutput();
        expect(rows).toHaveLength(2);
        for (const r of rows) {
            expect(r.classInfo).toEqual({
                attendeeEventId: 'ev-1',
                attendeeClasses: [{ key: 'class-ev-1', value: { investorFlag: 1 } }]
            });
        }
    });

    it('defineProperty keyed on classInfo recomputes after late secondary add (defensive if group row precedes items)', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<AllocationRow, 'allocations'>('allocations')
                .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')
                .pickByMax('allocations', 'createdAt', 'latestAllocation')
                .enrich(
                    'attendeeClasses',
                    createPipeline<ClassRow, 'attendeeClasses'>('attendeeClasses').groupBy(
                        ['attendeeEventId'],
                        'attendeeClasses'
                    ),
                    ['attendeeEventId'],
                    'classInfo',
                    whenMissing
                )
                .defineProperty(
                    'effectiveBucket',
                    row =>
                        row.classInfo.attendeeClasses?.[0]?.value.investorFlag === 1
                            ? 'investor'
                            : 'general',
                    ['classInfo']
                )
        );

        pipeline.add('alloc-1', {
            attendeePublicKey: 'pk-a',
            attendeeEventId: 'ev-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            votes: 1
        });

        expect(getOutput()[0].effectiveBucket).toBe('general');

        const sources = (pipeline as unknown as {
            sources: { attendeeClasses: { add: (key: string, immutableProps: ClassRow) => void } };
        }).sources;

        sources.attendeeClasses.add('class-ev-1', { attendeeEventId: 'ev-1', investorFlag: 1 });

        expect(getOutput()[0].effectiveBucket).toBe('investor');
    });
});
