// @ts-nocheck
/**
 * Placement as a changeable value.
 *
 * A node is identified by its level and key; its parent is a value that can change. These
 * tests check the property that follows: the output depends only on which rows exist, not on
 * the order in which they arrived, including when rows move between parents.
 */
import { createPipeline, toPipelinePlainOutput } from '../index';
import { createTestPipeline } from './helpers';

/** Sorts every array so that outputs can be compared regardless of insertion order. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonical(value[key])])
        );
    }
    return value;
}

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) {
        return [items];
    }
    return items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest])
    );
}

/** Runs every ordering of the operations and returns the distinct outputs and any diagnostics. */
function runAllOrders(makeBuilder, operations) {
    const outputs = new Set<string>();
    const diagnostics: string[] = [];
    for (const order of permutations(operations)) {
        const builder = makeBuilder();
        let state = [];
        const pipeline = builder.build(t => { state = t(state); }, { onDiagnostic: d => diagnostics.push(d.code) });
        order.forEach(operation => operation(pipeline));
        pipeline.flush();
        outputs.add(JSON.stringify(canonical(toPipelinePlainOutput(state, builder.getTypeDescriptor()))));
    }
    return { outputs: [...outputs].map(output => JSON.parse(output)), diagnostics };
}

describe('order independence', () => {
    it('issue #29 pipeline gives one result for every arrival order', () => {
        const classes = () => createPipeline('classes')
            .groupBy(['attendeeEventId'], 'byAttendeeEvent')
            .pickByMax('classes', 'attendeeClass', 'pickedClass')
            .dropProperty('classes');
        const makeBuilder = () => createPipeline('allocations')
            .groupBy(['attendeePublicKey', 'attendeeEventId'], 'attendees')
            .pickByMax('allocations', 'createdAt', 'latestAllocation')
            .dropProperty('allocations')
            .defineProperty('a1', a => a.latestAllocation?.a1 ?? 0, ['latestAllocation'])
            .dropProperty('latestAllocation')
            .enrich('attendeeClasses', classes(), ['attendeeEventId'], 'classInfo', { attendeeEventId: '', pickedClass: undefined })
            .defineProperty('effectiveClass', a => a.classInfo.pickedClass?.attendeeClass ?? 'general', ['classInfo'])
            .dropProperty('classInfo')
            .dropProperty('attendeeEventId')
            .groupBy(['effectiveClass'], 'classGroups')
            .sum('attendees', 'a1', 't1')
            .dropProperty('attendees');

        const operations = [
            p => p.add('x1', { attendeePublicKey: 'k1', attendeeEventId: 'AE1', a1: 100, createdAt: '2025-06-01T10:00:00Z' }),
            p => p.add('x2', { attendeePublicKey: 'k1', attendeeEventId: 'AE1', a1: 300, createdAt: '2025-06-01T11:00:00Z' }),
            p => p.add('x3', { attendeePublicKey: 'k2', attendeeEventId: 'AE2', a1: 50, createdAt: '2025-06-01T10:00:00Z' }),
            p => p.sources.attendeeClasses.add('c1', { attendeeEventId: 'AE1', attendeeClass: 'angel' }),
            p => p.sources.attendeeClasses.add('c2', { attendeeEventId: 'AE2', attendeeClass: 'virtual-angel' })
        ];

        const { outputs, diagnostics } = runAllOrders(makeBuilder, operations);
        expect(outputs).toEqual([
            [
                { effectiveClass: 'angel', t1: 300 },
                { effectiveClass: 'virtual-angel', t1: 50 }
            ]
        ]);
        expect(diagnostics).toEqual([]);
    });

    it('regrouping on an aggregate-derived key, with children and a nested aggregate', () => {
        const makeBuilder = () => createPipeline()
            .groupBy(['item'], 'groups')
            .sum('items', 'v', 'total')
            .defineProperty('tier', r => ((r.total ?? 0) > 50 ? 'hi' : 'lo'), ['total'])
            .groupBy(['tier'], 'tiers')
            .sum('groups', 'total', 'tierTotal')
            .in('groups')
            .count('items', 'lines');

        const operations = [
            p => p.add('1', { item: 'a', v: 30 }),
            p => p.add('2', { item: 'a', v: 40 }),
            p => p.add('3', { item: 'b', v: 10 }),
            p => p.add('4', { item: 'b', v: 20 })
        ];

        const { outputs, diagnostics } = runAllOrders(makeBuilder, operations);
        expect(outputs).toEqual([
            canonical([
                { tier: 'hi', tierTotal: 70, groups: [{ item: 'a', total: 70, lines: 2, items: [{ v: 30 }, { v: 40 }] }] },
                { tier: 'lo', tierTotal: 30, groups: [{ item: 'b', total: 30, lines: 2, items: [{ v: 10 }, { v: 20 }] }] }
            ])
        ]);
        expect(diagnostics).toEqual([]);
    });

    it('filter admission gives one result for every arrival order', () => {
        const makeBuilder = () => createPipeline()
            .groupBy(['cat', 'item'], 'groups')
            .sum('items', 'v', 'total')
            .count('items', 'n')
            .filter(r => r.total > 50, ['total'])
            .groupBy(['cat'], 'cats')
            .sum('groups', 'total', 'tSum')
            .sum('groups', 'n', 'nSum')
            .dropProperty('groups');

        const operations = [
            p => p.add('1', { cat: 'c', item: 'i', v: 30 }),
            p => p.add('2', { cat: 'c', item: 'i', v: 40 }),
            p => p.add('3', { cat: 'c', item: 'j', v: 60 }),
            p => p.add('4', { cat: 'c', item: 'k', v: 5 })
        ];

        const { outputs } = runAllOrders(makeBuilder, operations);
        expect(outputs).toEqual([[{ cat: 'c', nSum: 3, tSum: 130 }]]);
    });
});

describe('moves', () => {
    const tierOf = r => ((r.total ?? 0) > 50 ? 'hi' : 'lo');

    it('moving back and forth leaves no stale state', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .sum('groups', 'total', 'tierTotal')
                .dropProperty('groups')
        );
        pipeline.add('1', { item: 'a', v: 30 });
        pipeline.add('2', { item: 'a', v: 40 });
        expect(getOutput()).toEqual([{ tier: 'hi', tierTotal: 70 }]);
        pipeline.remove('2', { item: 'a', v: 40 });
        expect(getOutput()).toEqual([{ tier: 'lo', tierTotal: 30 }]);
        pipeline.add('2', { item: 'a', v: 40 });
        pipeline.remove('1', { item: 'a', v: 30 });
        pipeline.remove('2', { item: 'a', v: 40 });
        expect(getOutput()).toEqual([]);
    });

    it('a nested groupBy follows its parent when the parent moves', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .in('groups', 'items')
                .groupBy(['color'], 'colors')
        );
        pipeline.add('1', { item: 'a', color: 'red', v: 30 });
        pipeline.add('2', { item: 'a', color: 'blue', v: 40 });
        const [tier] = getOutput();
        expect(getOutput()).toHaveLength(1);
        expect(tier.tier).toBe('hi');
        expect(canonical(tier.groups)).toEqual(canonical([
            { item: 'a', total: 70, colors: [{ color: 'red', items: [{ v: 30 }] }, { color: 'blue', items: [{ v: 40 }] }] }
        ]));
    });

    it('a nested groupBy regroups items that move to another parent', () => {
        // Inner groups are keyed by their parent, so the same color under two items is two groups.
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .in('items')
                .groupBy(['color'], 'colors')
        );
        pipeline.add('1', { item: 'a', color: 'red', v: 1 });
        pipeline.add('2', { item: 'b', color: 'red', v: 2 });
        expect(canonical(getOutput())).toEqual(canonical([
            { item: 'a', colors: [{ color: 'red', items: [{ v: 1 }] }] },
            { item: 'b', colors: [{ color: 'red', items: [{ v: 2 }] }] }
        ]));
        pipeline.remove('1', { item: 'a', color: 'red', v: 1 });
        expect(getOutput()).toEqual([{ item: 'b', colors: [{ color: 'red', items: [{ v: 2 }] }] }]);
    });

    it('enrich keeps tracking a primary row after it moves', () => {
        const labels = () => createPipeline('labels').groupBy(['item'], 'byItem').pickByMax('labels', 'label', 'picked').dropProperty('labels');
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .dropProperty('items')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .in('groups')
                .enrich('labels', labels(), ['item'], 'info', { item: '', picked: undefined })
                .defineProperty('label', r => r.info.picked?.label ?? 'none', ['info'])
                .in('groups')
                .dropProperty('info')
        );
        // The row starts in 'lo' and moves to 'hi' before its enrichment arrives.
        pipeline.add('1', { item: 'a', v: 30 });
        pipeline.add('2', { item: 'a', v: 40 });
        pipeline.sources.labels.add('l1', { item: 'a', label: 'Apple' });
        expect(getOutput()).toEqual([{ tier: 'hi', groups: [{ item: 'a', total: 70, label: 'Apple' }] }]);
        pipeline.sources.labels.remove('l1', { item: 'a', label: 'Apple' });
        expect(getOutput()).toEqual([{ tier: 'hi', groups: [{ item: 'a', total: 70, label: 'none' }] }]);
    });

    it('flatten moves flattened items with their parent', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .flatten('groups', 'items', 'lines')
        );
        pipeline.add('1', { item: 'a', v: 30 });
        pipeline.add('2', { item: 'a', v: 40 });
        expect(canonical(getOutput())).toEqual(canonical([
            { tier: 'hi', lines: [{ item: 'a', total: 70, v: 30 }, { item: 'a', total: 70, v: 40 }] }
        ]));
    });

    it('cumulativeSum recomputes both parents when an item moves', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline('items', [
                { name: 'series', type: 'string' },
                { name: 'time', type: 'number' },
                { name: 'v', type: 'number' }
            ])
                .groupBy(['series', 'time'], 'points')
                .sum('items', 'v', 'value')
                .dropProperty('items')
                .defineProperty('bucket', r => ((r.value ?? 0) > 10 ? 'big' : 'small'), ['value'])
                .groupBy(['bucket'], 'buckets')
                .cumulativeSum('points', ['time'], ['value'])
        );
        pipeline.add('1', { series: 's', time: 1, v: 5 });
        pipeline.add('2', { series: 's', time: 2, v: 7 });
        pipeline.add('3', { series: 's', time: 3, v: 4 });
        expect(getOutput()).toEqual([
            { bucket: 'small', points: [{ series: 's', time: 1, value: 5 }, { series: 's', time: 2, value: 12 }, { series: 's', time: 3, value: 16 }] }
        ]);
        // Time 1 grows past the threshold and moves to the other bucket.
        pipeline.add('4', { series: 's', time: 1, v: 20 });
        expect(canonical(getOutput())).toEqual(canonical([
            { bucket: 'small', points: [{ series: 's', time: 2, value: 7 }, { series: 's', time: 3, value: 11 }] },
            { bucket: 'big', points: [{ series: 's', time: 1, value: 25 }] }
        ]));
    });
});

describe('filter membership', () => {
    it('hiding and showing an item replays its children once', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .filter(r => r.total > 50, ['total'])
                .count('items', 'shown')
        );
        pipeline.add('1', { item: 'a', v: 60 });
        pipeline.add('2', { item: 'a', v: -20 });
        expect(getOutput()).toEqual([]);
        pipeline.add('3', { item: 'a', v: 30 });
        expect(getOutput()).toEqual([
            { item: 'a', total: 70, shown: 3, items: [{ v: 60 }, { v: -20 }, { v: 30 }] }
        ]);
    });

    it('re-evaluates a filter at a nested scope', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['cat'], 'cats')
                .in('items')
                .groupBy(['item'], 'groups')
                .in('groups')
                .sum('items', 'v', 'total')
                .in('groups')
                .filter(r => r.total > 50, ['total'])
        );
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        expect(getOutput()).toEqual([{ cat: 'c', groups: [] }]);
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()).toEqual([{ cat: 'c', groups: [{ item: 'a', total: 70, items: [{ v: 30 }, { v: 40 }] }] }]);
    });
});

describe('source-level child keys', () => {
    it('children with the same key under different parents are distinct', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline('folders', [{ name: 'name', type: 'string' }], [
                { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [], mutableProperties: [] } }
            ]).sum('files', 'size', 'total')
        );
        pipeline.add('F1', { name: 'one' });
        pipeline.add('F2', { name: 'two' });
        pipeline.collection('files').add('F1', '1', { size: 10 });
        pipeline.collection('files').add('F2', '1', { size: 20 });
        expect(canonical(getOutput())).toEqual(canonical([
            { name: 'one', total: 10, files: [{ size: 10 }] },
            { name: 'two', total: 20, files: [{ size: 20 }] }
        ]));
        pipeline.collection('files').remove('F1', '1', { size: 10 });
        expect(canonical(getOutput())).toEqual(canonical([
            { name: 'one', total: 0, files: [] },
            { name: 'two', total: 20, files: [{ size: 20 }] }
        ]));
    });
});

describe('review regressions', () => {
    const filesPipeline = () =>
        createPipeline('folders', [{ name: 'name', type: 'string' }], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [], mutableProperties: [] } }
        ]);

    it('filter forgets the subtree of a removed item', () => {
        const [pipeline, getOutput] = createTestPipeline(() => filesPipeline().filter(() => true, []));
        pipeline.add('F1', { name: 'one' });
        pipeline.collection('files').add('F1', '1', { size: 10 });
        pipeline.remove('F1', { name: 'one' });
        pipeline.add('F1', { name: 'one' });
        expect(getOutput()).toEqual([{ name: 'one', files: [] }]);
    });

    it('max emits one change per value change', () => {
        const seen: unknown[] = [];
        const [pipeline] = createTestPipeline(() =>
            createPipeline()
                .groupBy(['city'], 'cities')
                .sum('items', 'capacity', 'total')
                .dropProperty('items')
                .groupBy(['state'], 'states')
                .max('cities', 'total', 'maxTotal')
                .defineProperty('watch', r => { seen.push(r.maxTotal); return r.maxTotal; }, ['maxTotal'])
        );
        pipeline.add('1', { state: 'TX', city: 'Austin', capacity: 5 });
        pipeline.add('2', { state: 'TX', city: 'Dallas', capacity: 10 });
        seen.length = 0;
        pipeline.add('3', { state: 'TX', city: 'Dallas', capacity: 1 });
        expect(seen).toEqual([11]);
    });

    it('removing a child that is not in the output is silent', () => {
        const diagnostics: string[] = [];
        const builder = filesPipeline();
        const pipeline = builder.build(() => {}, { onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.add('F1', { name: 'one' });
        pipeline.collection('files').remove('F1', '1', { size: 10 });
        pipeline.flush();
        expect(diagnostics).toEqual([]);
    });

    it('a child added before its parent is dropped and does not linger', () => {
        const diagnostics: string[] = [];
        const builder = filesPipeline().sum('files', 'size', 'total');
        let state = [];
        const pipeline = builder.build(t => { state = t(state); }, { onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.collection('files').add('F9', '1', { size: 10 });
        pipeline.add('F9', { name: 'nine' });
        pipeline.flush();
        // The child and the aggregate change it caused are both reported and dropped.
        expect([...diagnostics].sort()).toEqual(['missing_item_modify_dropped', 'missing_parent_add_dropped']);
        expect(toPipelinePlainOutput(state, builder.getTypeDescriptor())).toEqual([{ name: 'nine', files: [] }]);
    });
});
