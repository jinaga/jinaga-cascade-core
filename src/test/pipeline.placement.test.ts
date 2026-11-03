// @ts-nocheck
/**
 * Placement as a changeable value.
 *
 * A node is identified by its level and key; its parent is a value that can change. These
 * tests check the property that follows: the output depends only on which rows exist, not on
 * the order in which they arrived, including when rows move between parents.
 */
import { createPipeline, toPipelinePlainOutput } from '../index';
import { getPathSegmentsFromDescriptor } from '../pipeline';
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
                { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
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
            { name: 'one', files: [] },
            { name: 'two', total: 20, files: [{ size: 20 }] }
        ]));
    });
});

describe('review regressions', () => {
    const filesPipeline = () =>
        createPipeline('folders', [{ name: 'name', type: 'string' }], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
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

    it('a child added before its parent is refused, and no aggregate counts it (#31)', () => {
        const diagnostics: string[] = [];
        const builder = filesPipeline().sum('files', 'size', 'total');
        let state = [];
        const pipeline = builder.build(t => { state = t(state); }, { onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.collection('files').add('F9', '1', { size: 10 });
        pipeline.add('F9', { name: 'nine' });
        pipeline.collection('files').add('F9', '2', { size: 5 });
        pipeline.flush();
        expect(diagnostics).toEqual(['missing_parent_add_dropped']);
        expect(toPipelinePlainOutput(state, builder.getTypeDescriptor())).toEqual([
            { name: 'nine', total: 5, files: [{ size: 5 }] }
        ]);
    });
});

describe('removing a parent before its children', () => {
    const filesPipeline = () =>
        createPipeline('folders', [{ name: 'name', type: 'string' }], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
        ]);

    it('filter removes the admitted subtree of a removed item', () => {
        const removed: string[] = [];
        const builder = filesPipeline().filter(() => true, []);
        const graph = (builder as any).lastBuilder.buildGraph({});
        graph.rootInput.setSources(graph.sources);
        graph.lastStep.onRemoved(['files'], key => removed.push('file:' + key));
        graph.lastStep.onRemoved([], key => removed.push('folder:' + key));
        graph.rootInput.add('F1', { name: 'one' });
        graph.rootInput.addAt(['files'], ['F1'], '1', { size: 10 });
        graph.rootInput.remove('F1', { name: 'one' });
        expect(removed).toHaveLength(2);
        expect(removed[0]).toMatch(/^file:/);
        expect(removed[1]).toBe('folder:F1');
    });

    it('flatten removes flattened children when their parent is removed', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline('roots', [{ name: 'r', type: 'string' }], [
                {
                    name: 'folders',
                    type: {
                        arrays: [{ name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }],
                        collectionKey: [],
                        scalars: [{ name: 'name', type: 'string' }],
                        objects: []
                    }
                }
            ]).flatten('folders', 'files', 'allFiles')
        );
        pipeline.add('R', { r: 'root' });
        pipeline.collection('folders').add('R', 'F1', { name: 'one' });
        pipeline.collection('folders', 'files').add(['R', 'F1'], '1', { size: 10 });
        expect(getOutput()).toEqual([{ r: 'root', allFiles: [{ name: 'one', size: 10 }] }]);
        pipeline.collection('folders').remove('R', 'F1', { name: 'one' });
        expect(getOutput()).toEqual([{ r: 'root', allFiles: [] }]);
    });
});

describe('second review regressions', () => {
    const treePipeline = () =>
        createPipeline('roots', [{ name: 'r', type: 'string' }], [
            {
                name: 'folders',
                type: {
                    arrays: [{ name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }],
                    collectionKey: [],
                    scalars: [{ name: 'name', type: 'string' }],
                    objects: []
                }
            }
        ]);

    it('removing a row removes its remaining children first', () => {
        const removed: string[] = [];
        const graph = (treePipeline() as any).lastBuilder.buildGraph({});
        graph.lastStep.onRemoved([], key => removed.push(`root:${key}`));
        graph.lastStep.onRemoved(['folders'], () => removed.push('folder'));
        graph.lastStep.onRemoved(['folders', 'files'], () => removed.push('file'));
        graph.rootInput.add('R', { r: 'root' });
        graph.rootInput.addAt(['folders'], ['R'], 'F1', { name: 'one' });
        graph.rootInput.addAt(['folders', 'files'], ['R', 'F1'], '1', { size: 10 });
        graph.rootInput.remove('R', { r: 'root' });
        expect(removed).toEqual(['file', 'folder', 'root:R']);
        // Removing a child that went with its parent is a no-op.
        graph.rootInput.removeAt(['folders', 'files'], ['R', 'F1'], '1', { size: 10 });
        expect(removed).toHaveLength(3);
    });

    it('a nested filter does not replay a subtree removed with its ancestor', () => {
        const [pipeline, getOutput] = createTestPipeline(() => treePipeline().in('folders').filter(() => true, []));
        pipeline.add('R', { r: 'root' });
        pipeline.collection('folders').add('R', 'F1', { name: 'one' });
        pipeline.collection('folders', 'files').add(['R', 'F1'], '1', { size: 10 });
        pipeline.remove('R', { r: 'root' });
        pipeline.add('R', { r: 'root' });
        pipeline.collection('folders').add('R', 'F1', { name: 'one' });
        expect(getOutput()).toEqual([{ r: 'root', folders: [{ name: 'one', files: [] }] }]);
    });

    it('filter keeps a scope item visible when a descendant with the same key is removed', () => {
        const handlers = { added: new Map(), removed: new Map() };
        const fakeInput = {
            onAdded: (path, h) => handlers.added.set(JSON.stringify(path), h),
            onRemoved: (path, h) => handlers.removed.set(JSON.stringify(path), h),
            onModified: () => {},
            onPlaced: () => {}
        };
        const descriptor = {
            rootCollectionName: 'items', collectionKey: [], scalars: [], objects: [], mutableProperties: [],
            arrays: [{ name: 'children', type: { arrays: [], collectionKey: [], scalars: [], objects: [], mutableProperties: [] }, mutablePlacement: false }]
        };
        const { FilterStep } = require('../steps/filter');
        const step = new FilterStep(fakeInput, () => true, [], [], descriptor);
        const removed: string[] = [];
        step.onRemoved([], key => removed.push(key));
        handlers.added.get('[]')(undefined, 'X', {});
        handlers.added.get('["children"]')('X', 'X', {});
        handlers.removed.get('["children"]')('X', {});
        handlers.removed.get('[]')('X', {});
        expect(removed).toEqual(['X']);
    });

    it('a subscriber that reacts to a synchronous flush can add a child of the row it just saw', () => {
        const diagnostics: string[] = [];
        const builder = createPipeline('folders', [{ name: 'name', type: 'string' }], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
        ]);
        let state = [];
        let pipeline;
        let reacted = false;
        pipeline = builder.build(t => {
            state = t(state);
            if (!reacted && state.length === 1) {
                reacted = true;
                pipeline.collection('files').add('F1', '1', { size: 10 });
            }
        }, { batchSize: 1, onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.add('F1', { name: 'one' });
        pipeline.flush();
        expect(diagnostics).toEqual([]);
        expect(toPipelinePlainOutput(state, builder.getTypeDescriptor())).toEqual([{ name: 'one', files: [{ size: 10 }] }]);
    });
});

describe('aggregates match the proven model', () => {
    const files = () =>
        createPipeline('folders', [{ name: 'name', type: 'string' }], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }
        ]);

    it('a parent that lost its last child has no aggregate, like one that never had any', () => {
        const [pipeline, getOutput] = createTestPipeline(() => files().sum('files', 'size', 'total'));
        pipeline.add('F1', { name: 'one' });
        pipeline.add('F2', { name: 'two' });
        pipeline.collection('files').add('F1', '1', { size: 10 });
        pipeline.collection('files').remove('F1', '1', { size: 10 });
        expect(canonical(getOutput())).toEqual(canonical([
            { name: 'one', files: [] },
            { name: 'two', files: [] }
        ]));
    });

    /** Records each value a downstream step sees for `prop` on root rows. */
    const watch = (builder, prop: string) => {
        const seen: unknown[] = [];
        const [pipeline] = createTestPipeline(() =>
            builder.defineProperty('seen', r => { seen.push(r[prop]); return 0; }, [prop])
        );
        return { pipeline, seen };
    };

    it('sum emits nothing when a change leaves the total as it was', () => {
        const { pipeline, seen } = watch(createPipeline().groupBy(['g'], 'groups').sum('items', 'v', 'total'), 'total');
        pipeline.add('1', { g: 'a', v: 5 });
        seen.length = 0;
        pipeline.add('2', { g: 'a', v: 0 });
        expect(seen).toEqual([]);
    });

    it('min, max and average emit nothing when their value is unchanged', () => {
        for (const agg of ['min', 'max', 'average']) {
            const { pipeline, seen } = watch(createPipeline().groupBy(['g'], 'groups')[agg]('items', 'v', 'out'), 'out');
            pipeline.add('1', { g: 'a', v: 5 });
            seen.length = 0;
            pipeline.add('2', { g: 'a', v: 5 });
            expect(seen).toEqual([]);
        }
    });

    it('pickByMax emits nothing when the picked row is unchanged', () => {
        const { pipeline, seen } = watch(createPipeline().groupBy(['g'], 'groups').pickByMax('items', 'v', 'top'), 'top');
        pipeline.add('1', { g: 'a', v: 9 });
        seen.length = 0;
        pipeline.add('2', { g: 'a', v: 1 });
        expect(seen).toEqual([]);
    });
});

describe('reentrant subscribers', () => {
    it('a row added while its group is being created joins that group', () => {
        const diagnostics: string[] = [];
        const builder = createPipeline().groupBy(['g'], 'groups').count('items', 'n');
        let state = [];
        let pipeline;
        let reacted = false;
        pipeline = builder.build(t => {
            state = t(state);
            if (!reacted && state.length === 1) {
                reacted = true;
                pipeline.add('2', { g: 'a', v: 2 });
            }
        }, { batchSize: 1, onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.add('1', { g: 'a', v: 1 });
        pipeline.remove('1', { g: 'a', v: 1 });
        pipeline.flush();
        expect(diagnostics).toEqual([]);
        expect(toPipelinePlainOutput(state, builder.getTypeDescriptor())).toEqual([{ g: 'a', n: 1, items: [{ v: 2 }] }]);
    });
});

describe('orphan children', () => {
    it('a grandchild whose parent was refused is refused too, and an orphan removal is a no-op', () => {
        const diagnostics: string[] = [];
        const builder = createPipeline('roots', [{ name: 'r', type: 'string' }], [
            {
                name: 'folders',
                type: {
                    arrays: [{ name: 'files', type: { arrays: [], collectionKey: [], scalars: [{ name: 'size', type: 'number' }], objects: [] } }],
                    collectionKey: [],
                    scalars: [{ name: 'name', type: 'string' }],
                    objects: []
                }
            }
        ]).in('folders').count('files', 'n');
        let state = [];
        const pipeline = builder.build(t => { state = t(state); }, { onDiagnostic: d => diagnostics.push(d.code) });
        pipeline.add('R', { r: 'root' });
        pipeline.collection('folders', 'files').add(['R', 'F1'], '1', { size: 10 });
        pipeline.collection('folders', 'files').remove(['R', 'F1'], '1', { size: 10 });
        pipeline.collection('folders').add('R', 'F1', { name: 'one' });
        pipeline.flush();
        expect(diagnostics).toEqual(['missing_parent_add_dropped']);
        expect(toPipelinePlainOutput(state, builder.getTypeDescriptor())).toEqual([
            { r: 'root', folders: [{ name: 'one', files: [] }] }
        ]);
    });
});

describe('mutable placement (#30)', () => {
    const tierOf = r => ((r.total ?? 0) > 50 ? 'hi' : 'lo');

    /** Groups move between tiers; each tier has a value derived when it is created. */
    const tiersByCategory = () => createPipeline()
        .groupBy(['cat', 'item'], 'groups')
        .sum('items', 'v', 'total')
        .defineProperty('tier', tierOf, ['total'])
        .groupBy(['cat', 'tier'], 'tiers')
        .defineProperty('label', t => t.tier.toUpperCase())
        .groupBy(['cat'], 'cats');

    /** The array descriptor at a path; the root has none. */
    function arrayAt(descriptor, path) {
        let node = descriptor;
        let array = undefined;
        for (const segment of path) {
            array = node.arrays.find(a => a.name === segment);
            node = array.type;
        }
        return array;
    }

    /**
     * Runs the operations, and returns the levels of the moves the pipeline emitted that its
     * descriptor does not declare, and the number of moves.
     */
    function undeclaredMoves(builder, operations) {
        const descriptor = builder.getTypeDescriptor();
        const lastBuilder = builder.lastBuilder;
        const buildGraph = lastBuilder.buildGraph.bind(lastBuilder);
        let graph;
        lastBuilder.buildGraph = ctx => (graph = buildGraph(ctx));
        const pipeline = builder.build(() => {});
        const undeclared = new Set<string>();
        let moves = 0;
        for (const path of getPathSegmentsFromDescriptor(descriptor)) {
            graph.lastStep.onPlaced(path, () => {
                moves += 1;
                if (!arrayAt(descriptor, path)?.mutablePlacement) {
                    undeclared.add(path.join('.'));
                }
            });
        }
        operations.forEach(operation => operation(pipeline));
        pipeline.flush();
        return { undeclared: [...undeclared], moves };
    }

    it('a flattened item takes on the values of the parent it moves to', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            tiersByCategory().flatten('tiers', 'groups', 'flat')
        );
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        expect(getOutput()).toEqual([
            { cat: 'c', flat: [{ tier: 'lo', label: 'LO', item: 'a', total: 30, items: [{ v: 30 }] }] }
        ]);
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()).toEqual([
            { cat: 'c', flat: [{ tier: 'hi', label: 'HI', item: 'a', total: 70, items: [{ v: 30 }, { v: 40 }] }] }
        ]);
    });

    it('a step after flatten sees an inherited value change', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            tiersByCategory()
                .flatten('tiers', 'groups', 'flat')
                .in('flat')
                .groupBy(['label'], 'labels')
        );
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()).toEqual([
            { cat: 'c', labels: [{ label: 'HI', flat: [{ tier: 'hi', item: 'a', total: 70, items: [{ v: 30 }, { v: 40 }] }] }] }
        ]);
    });

    it('a child object of the same name does not shadow an inherited value', () => {
        // groupBy copies the source object's descriptor to the group level, which has no value for it.
        const emptyNode = { arrays: [], collectionKey: [], scalars: [], objects: [] };
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline('rows', [], [], [{ name: 'label', type: emptyNode }])
                .groupBy(['cat', 'item'], 'groups')
                .sum('rows', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['cat', 'tier'], 'tiers')
                .defineProperty('label', t => t.tier.toUpperCase())
                .groupBy(['cat'], 'cats')
                .flatten('tiers', 'groups', 'flat')
        );
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()[0].flat[0].label).toBe('HI');
    });

    it('dropping an array keeps the placement of the levels around it', () => {
        const builder = () => createPipeline()
            .groupBy(['cat', 'item'], 'groups')
            .sum('items', 'v', 'total')
            .defineProperty('tier', tierOf, ['total'])
            .groupBy(['cat', 'tier'], 'tiers')
            .defineProperty('label', t => t.tier.toUpperCase())
            .in('groups')
            .dropProperty('items')
            .groupBy(['cat'], 'cats')
            .flatten('tiers', 'groups', 'flat');
        expect(arrayAt(builder().getTypeDescriptor(), ['flat']).mutablePlacement).toBe(true);
        const [pipeline, getOutput] = createTestPipeline(builder);
        pipeline.add('1', { cat: 'c', item: 'a', v: 30 });
        pipeline.add('2', { cat: 'c', item: 'a', v: 40 });
        expect(getOutput()).toEqual([{ cat: 'c', flat: [{ tier: 'hi', label: 'HI', item: 'a', total: 70 }] }]);
    });

    it('records which arrays have items that can move', () => {
        const descriptor = tiersByCategory().getTypeDescriptor();
        expect(arrayAt(descriptor, ['tiers']).mutablePlacement).toBe(false);
        expect(arrayAt(descriptor, ['tiers', 'groups']).mutablePlacement).toBe(true);
        expect(arrayAt(descriptor, ['tiers', 'groups', 'items']).mutablePlacement).toBe(false);

        const flattened = tiersByCategory().flatten('tiers', 'groups', 'flat').getTypeDescriptor();
        expect(arrayAt(flattened, ['flat']).mutablePlacement).toBe(true);
        expect(arrayAt(flattened, ['flat']).type.mutableProperties).toEqual(expect.arrayContaining(['tier', 'label']));
    });

    it('inherited values are not mutable when the child cannot move', () => {
        const descriptor = createPipeline()
            .groupBy(['cat', 'sub'], 'subs')
            .groupBy(['cat'], 'cats')
            .flatten('subs', 'items', 'flat')
            .getTypeDescriptor();
        expect(arrayAt(descriptor, ['flat']).mutablePlacement).toBe(false);
        expect(arrayAt(descriptor, ['flat']).type.mutableProperties).toEqual([]);
    });

    it('source arrays never move', () => {
        const descriptor = createPipeline('roots', [], [
            { name: 'files', type: { arrays: [], collectionKey: [], scalars: [], objects: [] } }
        ]).getTypeDescriptor();
        expect(arrayAt(descriptor, ['files']).mutablePlacement).toBe(false);
    });

    describe('every move is at a level declared to move', () => {
        const rows = [
            p => p.add('1', { cat: 'c', item: 'a', v: 30 }),
            p => p.add('2', { cat: 'c', item: 'a', v: 40 }),
            p => p.remove('2', { cat: 'c', item: 'a', v: 40 })
        ];

        it('groupBy on a mutable key', () => {
            const { undeclared, moves } = undeclaredMoves(tiersByCategory(), rows);
            expect(moves).toBeGreaterThan(0);
            expect(undeclared).toEqual([]);
        });

        it('flatten of a parent that moves', () => {
            const builder = createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .flatten('groups', 'items', 'lines');
            const { undeclared, moves } = undeclaredMoves(builder, rows);
            expect(moves).toBeGreaterThan(0);
            expect(undeclared).toEqual([]);
        });

        it('a nested groupBy of items that move', () => {
            const builder = createPipeline()
                .groupBy(['item'], 'groups')
                .sum('items', 'v', 'total')
                .defineProperty('tier', tierOf, ['total'])
                .groupBy(['tier'], 'tiers')
                .in('groups')
                .groupBy(['item'], 'byItem');
            const { undeclared, moves } = undeclaredMoves(builder, rows);
            expect(moves).toBeGreaterThan(0);
            expect(undeclared).toEqual([]);
        });
    });
});
