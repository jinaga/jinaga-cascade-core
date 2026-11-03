/**
 * Issue #29 and its generalization.
 *
 * Two steps used to re-emit an existing item as a fresh add carrying only its add-time
 * payload: GroupByStep when a mutable grouping key changed, and FilterStep when a mutable
 * predicate input changed. Values that had arrived via `onModified`, and the item's
 * descendants, were lost at the new position.
 *
 * GroupBy now moves the item with `onPlaced`, and FilterStep adds admitted items with their
 * current values and subtree. Each test checks the result that does not depend on arrival order.
 */
import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

type ClassRow = { k: string; c: string };
type Line = { k: string; v: number };
type Row = { id: number; k: string; v: number };

const classPipeline = () =>
    createPipeline<ClassRow, 'classes'>('classes')
        .groupBy(['k'], 'byK')
        .pickByMax('classes', 'c', 'picked')
        .dropProperty('classes');

/** Lines grouped by `cl`, which comes from a late-arriving enrichment row. */
const linesByClass = () =>
    createPipeline<Line>()
        .enrich('classes', classPipeline(), ['k'], 'ci', { k: '', picked: undefined })
        .defineProperty('cl', r => r.ci.picked?.c ?? 'general', ['ci'])
        .dropProperty('ci')
        .groupBy(['cl'], 'g');

/** One row per id, with mutable `a1` from an aggregate, regrouped by late enrichment. */
const enrichedRows = () =>
    createPipeline<Row>()
        .groupBy(['id', 'k'], 'rows')
        .sum('items', 'v', 'a1')
        .dropProperty('items')
        .enrich('classes', classPipeline(), ['k'], 'ci', { k: '', picked: undefined })
        .defineProperty('cl', r => r.ci.picked?.c ?? 'general', ['ci'])
        .dropProperty('ci')
        .dropProperty('k')
        .groupBy(['cl'], 'g');

type WithClasses = { sources: { classes: { add(key: string, row: ClassRow): void; remove(key: string, row: ClassRow): void } } };
const addClass = (pipeline: WithClasses) => pipeline.sources.classes.add('a', { k: 'K', c: 'vip' });
const removeClass = (pipeline: WithClasses) => pipeline.sources.classes.remove('a', { k: 'K', c: 'vip' });

describe('issue #29: enrich → groupBy → sum depends on arrival order', () => {
    const attendeeClassPipeline = createPipeline<{ attendeeEventId: string; attendeeClass: string }, 'classes'>('classes')
        .groupBy(['attendeeEventId'], 'byAttendeeEvent')
        .pickByMax('classes', 'attendeeClass', 'pickedClass')
        .dropProperty('classes');

    const issuePipeline = () =>
        createPipeline<{ id: string; attendeePublicKey: string; attendeeEventId: string; a1: number; createdAt: string }, 'allocations'>('allocations')
            .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')
            .pickByMax('allocations', 'createdAt', 'latestAllocation')
            .dropProperty('allocations')
            .defineProperty('a1', a => a.latestAllocation?.a1 ?? 0, ['latestAllocation'])
            .dropProperty('latestAllocation')
            .enrich('attendeeClasses', attendeeClassPipeline, ['attendeeEventId'], 'classInfo', {
                attendeeEventId: '',
                pickedClass: undefined
            })
            .defineProperty('effectiveClass', a => a.classInfo.pickedClass?.attendeeClass ?? 'general', ['classInfo'])
            .dropProperty('classInfo')
            .dropProperty('attendeeEventId')
            .groupBy(['effectiveClass'], 'classGroups')
            .sum('attendees', 'a1', 't1')
            .dropProperty('attendees');

    const allocation = { id: 'x', attendeePublicKey: 'k', attendeeEventId: 'AE', a1: 50000, createdAt: '2025-06-01T10:05:00Z' };
    const classRow = { attendeeEventId: 'AE', attendeeClass: 'virtual-angel' };

    it('class row first', () => {
        const [pipeline, getOutput] = createTestPipeline(issuePipeline);
        pipeline.sources.attendeeClasses.add('AE|a', classRow);
        pipeline.add('x', allocation);
        expect(getOutput()).toEqual([{ effectiveClass: 'virtual-angel', t1: 50000 }]);
    });

    it('allocation row first', () => {
        const [pipeline, getOutput] = createTestPipeline(issuePipeline);
        pipeline.add('x', allocation);
        pipeline.sources.attendeeClasses.add('AE|a', classRow);
        expect(getOutput()).toEqual([{ effectiveClass: 'virtual-angel', t1: 50000 }]);
    });
});

describe('groupBy regroup on a mutable key keeps values and descendants', () => {
    it('control: immutable aggregated property survives a regroup', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            linesByClass().sum('items', 'v', 't').dropProperty('items')
        );
        pipeline.add('x', { k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', t: 5 }]);
    });

    type Rows = ReturnType<typeof enrichedRows>;
    it.each([
        ['sum', (b: Rows) => b.sum('rows', 'a1', 'r')],
        ['min', (b: Rows) => b.min('rows', 'a1', 'r')],
        ['max', (b: Rows) => b.max('rows', 'a1', 'r')],
        ['average', (b: Rows) => b.average('rows', 'a1', 'r')]
    ] as const)('%s of a mutable property after a regroup', (_name, aggregate) => {
        const [pipeline, getOutput] = createTestPipeline(() => aggregate(enrichedRows()).dropProperty('rows'));
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', r: 5 }]);
    });

    it('pickByMax of a mutable property after a regroup', () => {
        const [pipeline, getOutput] = createTestPipeline(() => enrichedRows().pickByMax('rows', 'a1', 'r').dropProperty('rows'));
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', r: { id: 1, a1: 5 } }]);
    });

    it('output keeps the mutable value of a regrouped item', () => {
        const [pipeline, getOutput] = createTestPipeline(enrichedRows);
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', rows: [{ id: 1, a1: 5 }] }]);
    });

    it('later changes to the mutable value reach the new group', () => {
        const [pipeline, getOutput] = createTestPipeline(() => enrichedRows().sum('rows', 'a1', 'r').dropProperty('rows'));
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        pipeline.add('y', { id: 1, k: 'K', v: 7 });
        expect(getOutput()).toEqual([{ cl: 'vip', r: 12 }]);
    });

    it('removing the row after a regroup does not throw', () => {
        const [pipeline, getOutput] = createTestPipeline(() => enrichedRows().sum('rows', 'a1', 'r').dropProperty('rows'));
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        pipeline.remove('x', { id: 1, k: 'K', v: 5 });
        expect(getOutput()).toEqual([]);
    });

    it('regrouping back when the enrichment is removed does not throw', () => {
        const [pipeline, getOutput] = createTestPipeline(() => enrichedRows().sum('rows', 'a1', 'r').dropProperty('rows'));
        pipeline.add('x', { id: 1, k: 'K', v: 5 });
        addClass(pipeline);
        removeClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'general', r: 5 }]);
    });

    it('regrouped item does not carry the grouping property into the child', () => {
        const [pipeline, getOutput] = createTestPipeline(linesByClass);
        pipeline.add('x', { k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', items: [{ k: 'K', v: 5 }] }]);
    });

    describe('without enrich: key derived from an aggregate', () => {
        const tierOf = (r: { total: number | undefined }) => ((r.total ?? 0) > 50 ? 'hi' : 'lo');
        const tiers = () =>
            createPipeline<{ item: string; v: number }>()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .sum('groups', 'total', 'tierTotal')
                .dropProperty('groups');

        it('control: no threshold crossing', () => {
            const [pipeline, getOutput] = createTestPipeline(tiers);
            pipeline.add('1', { item: 'i', v: 30 });
            expect(getOutput()).toEqual([{ tier: 'lo', tierTotal: 30 }]);
        });

        it('sum after crossing the threshold', () => {
            const [pipeline, getOutput] = createTestPipeline(tiers);
            pipeline.add('1', { item: 'i', v: 30 });
            pipeline.add('2', { item: 'i', v: 40 });
            expect(getOutput()).toEqual([{ tier: 'hi', tierTotal: 70 }]);
        });

        it('a single row whose first value flips the key', () => {
            const [pipeline, getOutput] = createTestPipeline(tiers);
            pipeline.add('1', { item: 'i', v: 70 });
            expect(getOutput()).toEqual([{ tier: 'hi', tierTotal: 70 }]);
        });

        it('child array and its aggregate survive a regroup', () => {
            const [pipeline, getOutput] = createTestPipeline(() =>
                createPipeline<{ item: string; v: number }>()
                    .groupBy(['item'], 'groups')
                    .sum('items', 'v', 'total')
                    .defineProperty('tier', tierOf, ['total'])
                    .groupBy(['tier'], 'tiers')
                    .in('groups')
                    .sum('items', 'v', 'lineSum')
            );
            pipeline.add('1', { item: 'i', v: 30 });
            pipeline.add('2', { item: 'i', v: 40 });
            const [group] = getOutput()[0].groups;
            expect(group.lineSum).toBe(70);
            expect(group.items).toHaveLength(2);
        });
    });
});

describe('filter admitting an item on a mutable predicate', () => {
    type CatLine = { cat: string; item: string; v: number };
    const lines = (p: { add(key: string, row: CatLine): void }) => {
        p.add('1', { cat: 'c', item: 'i', v: 30 });
        p.add('2', { cat: 'c', item: 'i', v: 40 });
    };

    it('control: plain output after admission', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CatLine>()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .filter(r => r.total !== undefined && r.total > 50, ['total'])
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', item: 'i', total: 70 }]);
    });

    it('downstream sum of the predicate property counts the change once', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CatLine>()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .filter(r => r.total !== undefined && r.total > 50, ['total'])
                .groupBy(['cat'], 'cats')
                .sum('groups', 'total', 'tSum')
                .dropProperty('groups')
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', tSum: 70 }]);
    });

    it('downstream sum of another mutable property sees its current value', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<CatLine>()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .count('items', 'n')
                .dropProperty('items')
                .filter(r => r.total !== undefined && r.total > 50, ['total'])
                .groupBy(['cat'], 'cats')
                .sum('groups', 'n', 'nSum')
                .dropProperty('groups')
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', nSum: 2 }]);
    });
});
