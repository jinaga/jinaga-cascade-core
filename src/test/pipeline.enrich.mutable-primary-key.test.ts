/**
 * Regression tests for EnrichStep when primary join keys can change after add
 * (e.g. via defineProperty depending on mutable aggregate `total`).
 *
 * EnrichStep listens for `onModified` on each `primaryKey` column, moves primaries between
 * join-key index sets, and emits `onModified` for the `as` property when enrichment changes.
 */
import { createPipeline } from '../index';
import { createTestPipeline } from './helpers';

interface BucketSource {
    joinKey: string;
    label: string;
}

interface CompositeBucketSource {
    compositeKey: string;
    label: string;
}

function bucketLabelFromEnrichment(bucketInfo: unknown): string | undefined {
    const row = bucketInfo as { buckets?: Array<{ value?: { label?: string } }> } | undefined;
    return row?.buckets?.[0]?.value?.label;
}

function regionTagFromEnrichment(regionInfo: unknown): string | undefined {
    const row = regionInfo as { regions?: Array<{ value?: { tag?: string } }> } | undefined;
    return row?.regions?.[0]?.value?.tag;
}

function compositeLabel(extra: unknown): string | undefined {
    const row = extra as { rows?: Array<{ value?: { label?: string } }> } | undefined;
    return row?.rows?.[0]?.value?.label;
}

describe('enrich — primary join key changes after add (expected failures until reindex)', () => {
    /**
     * Scenario 1 — “mutable FK”: join key derived from aggregate crosses a threshold;
     * secondary has both targets. Enrichment should follow the new key.
     */
    it('scenario 1: after total crosses threshold, enrichment should match secondary for new join key', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('joinKey', item => (item.total > 50 ? 'high' : 'low'), ['total'])
                .enrich(
                    'buckets',
                    createPipeline<BucketSource, 'buckets'>('buckets').groupBy(['joinKey'], 'buckets'),
                    ['joinKey'],
                    'bucketInfo'
                )
        );

        const sources = pipeline.sources as {
            buckets: { add: (key: string, row: BucketSource) => void };
        };
        sources.buckets.add('s-high', { joinKey: 'high', label: 'High tier' });
        sources.buckets.add('s-low', { joinKey: 'low', label: 'Low tier' });

        pipeline.add('l1', { orderId: 'o1', amount: 30 });
        expect(getOutput()[0].joinKey).toBe('low');
        expect(bucketLabelFromEnrichment(getOutput()[0].bucketInfo)).toBe('Low tier');

        pipeline.add('l2', { orderId: 'o1', amount: 40 });

        const row = getOutput()[0];
        expect(row.joinKey).toBe('high');
        expect(bucketLabelFromEnrichment(row.bucketInfo)).toBe('High tier');
    });

    /**
     * Scenario 2 — computed defineProperty key: same mechanism, different thresholds;
     * stresses that recompute is driven by `total` onModified, not remove/add.
     */
    it('scenario 2: defineProperty joinKey should drive enrichment when only total mutates', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('regionKey', item => (item.total > 40 ? 'east' : 'west'), ['total'])
                .enrich(
                    'regions',
                    createPipeline<{ regionKey: string; tag: string }, 'regions'>('regions').groupBy(
                        ['regionKey'],
                        'regions'
                    ),
                    ['regionKey'],
                    'regionInfo',
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { regionKey: '', regions: [] } as any
                )
        );

        const sources = pipeline.sources as {
            regions: { add: (key: string, row: { regionKey: string; tag: string }) => void };
        };
        sources.regions.add('r-east', { regionKey: 'east', tag: 'EAST' });
        sources.regions.add('r-west', { regionKey: 'west', tag: 'WEST' });

        pipeline.add('a', { orderId: 'o1', amount: 20 });
        expect(getOutput()[0].regionKey).toBe('west');

        pipeline.add('b', { orderId: 'o1', amount: 25 });

        const row = getOutput()[0];
        expect(row.regionKey).toBe('east');
        expect(regionTagFromEnrichment(row.regionInfo)).toBe('EAST');
    });

    /**
     * Scenario 3 — secondary static: both secondary rows registered before any primary add;
     * no further secondary mutations while the primary join key changes (different threshold than scenario 1).
     */
    it('scenario 3: secondary fully preloaded — no source adds during primary-only updates', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('joinKey', item => (item.total > 100 ? 'vip' : 'std'), ['total'])
                .enrich(
                    'buckets',
                    createPipeline<BucketSource, 'buckets'>('buckets').groupBy(['joinKey'], 'buckets'),
                    ['joinKey'],
                    'bucketInfo'
                )
        );

        const sources = pipeline.sources as {
            buckets: { add: (key: string, row: BucketSource) => void };
        };
        sources.buckets.add('s-vip', { joinKey: 'vip', label: 'VIP' });
        sources.buckets.add('s-std', { joinKey: 'std', label: 'Standard' });

        pipeline.add('l1', { orderId: 'o1', amount: 60 });
        pipeline.add('l2', { orderId: 'o1', amount: 50 });

        const row = getOutput()[0];
        expect(row.joinKey).toBe('vip');
        expect(bucketLabelFromEnrichment(row.bucketInfo)).toBe('VIP');
    });

    /**
     * Scenario 4 — collision: two groups share the same join key, then only one crosses the threshold.
     */
    it('scenario 4: only one of two primaries should move to a new join bucket', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('joinKey', item => (item.total > 50 ? 'high' : 'low'), ['total'])
                .enrich(
                    'buckets',
                    createPipeline<BucketSource, 'buckets'>('buckets').groupBy(['joinKey'], 'buckets'),
                    ['joinKey'],
                    'bucketInfo'
                )
        );

        const sources = pipeline.sources as {
            buckets: { add: (key: string, row: BucketSource) => void };
        };
        sources.buckets.add('s-high', { joinKey: 'high', label: 'High tier' });
        sources.buckets.add('s-low', { joinKey: 'low', label: 'Low tier' });

        pipeline.add('a', { orderId: 'o1', amount: 30 });
        pipeline.add('b', { orderId: 'o2', amount: 30 });
        expect(getOutput()).toHaveLength(2);
        expect(getOutput()[0].joinKey).toBe('low');
        expect(getOutput()[1].joinKey).toBe('low');

        pipeline.add('c', { orderId: 'o1', amount: 40 });

        const rows = getOutput().slice().sort((x, y) => x.orderId.localeCompare(y.orderId));
        const o1 = rows.find(r => r.orderId === 'o1')!;
        const o2 = rows.find(r => r.orderId === 'o2')!;
        expect(o1.joinKey).toBe('high');
        expect(o2.joinKey).toBe('low');
        expect(bucketLabelFromEnrichment(o1.bucketInfo)).toBe('High tier');
        expect(bucketLabelFromEnrichment(o2.bucketInfo)).toBe('Low tier');
    });

    /**
     * Scenario 5 — whenMissing: primary starts in a band with no secondary row, then moves to a matched band.
     */
    it('scenario 5: whenMissing then real match after join key changes', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('joinKey', item => (item.total > 50 ? 'high' : 'low'), ['total'])
                .enrich(
                    'buckets',
                    createPipeline<BucketSource, 'buckets'>('buckets').groupBy(['joinKey'], 'buckets'),
                    ['joinKey'],
                    'bucketInfo',
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { joinKey: '', buckets: [] } as any
                )
        );

        const sources = pipeline.sources as {
            buckets: { add: (key: string, row: BucketSource) => void };
        };
        sources.buckets.add('s-high', { joinKey: 'high', label: 'High tier' });

        pipeline.add('l1', { orderId: 'o1', amount: 30 });
        let row = getOutput()[0];
        expect(row.joinKey).toBe('low');
        expect(row.bucketInfo).toEqual({ joinKey: '', buckets: [] });

        pipeline.add('l2', { orderId: 'o1', amount: 40 });
        row = getOutput()[0];
        expect(row.joinKey).toBe('high');
        expect(bucketLabelFromEnrichment(row.bucketInfo)).toBe('High tier');
    });

    /**
     * Scenario 6 — enriched secondary row’s own join key should match primary joinKey (detects stale `as`).
     */
    it('scenario 6: bucketInfo.joinKey should match primary joinKey after recompute', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty('joinKey', item => (item.total > 50 ? 'high' : 'low'), ['total'])
                .enrich(
                    'buckets',
                    createPipeline<BucketSource, 'buckets'>('buckets').groupBy(['joinKey'], 'buckets'),
                    ['joinKey'],
                    'bucketInfo'
                )
        );

        const sources = pipeline.sources as {
            buckets: { add: (key: string, row: BucketSource) => void };
        };
        sources.buckets.add('s-high', { joinKey: 'high', label: 'High tier' });
        sources.buckets.add('s-low', { joinKey: 'low', label: 'Low tier' });

        pipeline.add('l1', { orderId: 'o1', amount: 30 });
        pipeline.add('l2', { orderId: 'o1', amount: 40 });

        const row = getOutput()[0];
        const info = row.bucketInfo as { joinKey?: string } | undefined;
        expect(row.joinKey).toBe('high');
        expect(info?.joinKey).toBe(row.joinKey);
    });

    /**
     * Scenario 7 — composite-style join key string (multi-part semantics in one key).
     */
    it('scenario 7: composite join key should remap enrichment when total crosses threshold', () => {
        const [pipeline, getOutput] = createTestPipeline(() =>
            createPipeline<{ orderId: string; amount: number }>()
                .groupBy(['orderId'], 'lines')
                .sum('items', 'amount', 'total')
                .defineProperty(
                    'compositeKey',
                    item => `acc-${item.total > 50 ? 'big' : 'small'}`,
                    ['total']
                )
                .enrich(
                    'rows',
                    createPipeline<CompositeBucketSource, 'rows'>('rows').groupBy(['compositeKey'], 'rows'),
                    ['compositeKey'],
                    'extra'
                )
        );

        const sources = pipeline.sources as {
            rows: { add: (key: string, row: CompositeBucketSource) => void };
        };
        sources.rows.add('k1', { compositeKey: 'acc-big', label: 'Big pool' });
        sources.rows.add('k2', { compositeKey: 'acc-small', label: 'Small pool' });

        pipeline.add('l1', { orderId: 'o1', amount: 30 });
        expect(getOutput()[0].compositeKey).toBe('acc-small');
        expect(compositeLabel(getOutput()[0].extra)).toBe('Small pool');

        pipeline.add('l2', { orderId: 'o1', amount: 40 });

        const row = getOutput()[0];
        expect(row.compositeKey).toBe('acc-big');
        expect(compositeLabel(row.extra)).toBe('Big pool');
    });
});
