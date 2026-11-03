// @ts-nocheck
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

const classPipeline = () =>
    createPipeline('classes')
        .groupBy(['k'], 'byK')
        .pickByMax('classes', 'c', 'picked')
        .dropProperty('classes');

/** Group key `cl` comes from a late-arriving enrichment row. */
const withEnrichedKey = builder =>
    builder
        .enrich('classes', classPipeline(), ['k'], 'ci', { k: '', picked: undefined })
        .defineProperty('cl', r => r.ci.picked?.c ?? 'general', ['ci'])
        .dropProperty('ci');

/** One row per id, with mutable `a1` from an aggregate, regrouped by late enrichment. */
const enrichedRows = () =>
    withEnrichedKey(
        createPipeline()
            .groupBy(['id', 'k'], 'rows')
            .sum('items', 'v', 'a1')
            .dropProperty('items')
    )
        .dropProperty('k')
        .groupBy(['cl'], 'g');

const addClass = pipeline => pipeline.sources.classes.add('a', { k: 'K', c: 'vip' });
const removeClass = pipeline => pipeline.sources.classes.remove('a', { k: 'K', c: 'vip' });

describe('issue #29: enrich → groupBy → sum depends on arrival order', () => {
    const attendeeClassPipeline = createPipeline('classes')
        .groupBy(['attendeeEventId'], 'byAttendeeEvent')
        .pickByMax('classes', 'attendeeClass', 'pickedClass')
        .dropProperty('classes');

    const issuePipeline = () =>
        createPipeline('allocations')
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
            withEnrichedKey(createPipeline()).groupBy(['cl'], 'g').sum('items', 'v', 't').dropProperty('items')
        );
        pipeline.add('x', { k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', t: 5 }]);
    });

    it.each(['sum', 'min', 'max', 'average'])('%s of a mutable property after a regroup', agg => {
        const [pipeline, getOutput] = createTestPipeline(() => enrichedRows()[agg]('rows', 'a1', 'r').dropProperty('rows'));
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
        const [pipeline, getOutput] = createTestPipeline(() => withEnrichedKey(createPipeline()).groupBy(['cl'], 'g'));
        pipeline.add('x', { k: 'K', v: 5 });
        addClass(pipeline);
        expect(getOutput()).toEqual([{ cl: 'vip', items: [{ k: 'K', v: 5 }] }]);
    });

    describe('without enrich: key derived from an aggregate', () => {
        const tierOf = r => ((r.total ?? 0) > 50 ? 'hi' : 'lo');
        const tiers = () =>
            createPipeline()
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
                createPipeline()
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
    const lines = p => {
        p.add('1', { cat: 'c', item: 'i', v: 30 });
        p.add('2', { cat: 'c', item: 'i', v: 40 });
    };

    it('control: plain output after admission', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .filter(r => r.total > 50, ['total'])
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', item: 'i', total: 70 }]);
    });

    it('downstream sum of the predicate property counts the change once', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .filter(r => r.total > 50, ['total'])
                .groupBy(['cat'], 'cats')
                .sum('groups', 'total', 'tSum')
                .dropProperty('groups')
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', tSum: 70 }]);
    });

    it('downstream sum of another mutable property sees its current value', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['cat', 'item'], 'groups')
                .sum('items', 'v', 'total')
                .count('items', 'n')
                .dropProperty('items')
                .filter(r => r.total > 50, ['total'])
                .groupBy(['cat'], 'cats')
                .sum('groups', 'n', 'nSum')
                .dropProperty('groups')
        );
        lines(pipeline);
        expect(getOutput()).toEqual([{ cat: 'c', nSum: 2 }]);
    });
});
