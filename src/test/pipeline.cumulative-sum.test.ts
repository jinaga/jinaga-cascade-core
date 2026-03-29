// @ts-nocheck
import { createPipeline } from '../index';
import type { AddedHandler, ImmutableProps, ModifiedHandler, RemovedHandler, Step, TypeDescriptor } from '../pipeline';
import { CumulativeSumStep } from '../steps/cumulative-sum';
import { createTestPipeline } from './helpers';

type ModifiedEvent = {
    keyPath: string[];
    key: string;
    oldValue: unknown;
    newValue: unknown;
};

class FakeInputStep implements Step {
    private readonly addedHandlers: Map<string, AddedHandler[]> = new Map();
    private readonly removedHandlers: Map<string, RemovedHandler[]> = new Map();
    private readonly modifiedHandlers: Map<string, ModifiedHandler[]> = new Map();

    constructor(private descriptor: TypeDescriptor) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return this.descriptor;
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        const pathKey = JSON.stringify(pathSegments);
        const handlers = this.addedHandlers.get(pathKey) ?? [];
        handlers.push(handler);
        this.addedHandlers.set(pathKey, handlers);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        const pathKey = JSON.stringify(pathSegments);
        const handlers = this.removedHandlers.get(pathKey) ?? [];
        handlers.push(handler);
        this.removedHandlers.set(pathKey, handlers);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        const registrationKey = `${JSON.stringify(pathSegments)}::${propertyName}`;
        const handlers = this.modifiedHandlers.get(registrationKey) ?? [];
        handlers.push(handler);
        this.modifiedHandlers.set(registrationKey, handlers);
    }

    emitAdded(pathSegments: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        const pathKey = JSON.stringify(pathSegments);
        (this.addedHandlers.get(pathKey) ?? []).forEach(handler => handler(keyPath, key, immutableProps));
    }

    emitRemoved(pathSegments: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        const pathKey = JSON.stringify(pathSegments);
        (this.removedHandlers.get(pathKey) ?? []).forEach(handler => handler(keyPath, key, immutableProps));
    }

    emitModified(
        pathSegments: string[],
        propertyName: string,
        keyPath: string[],
        key: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        const registrationKey = `${JSON.stringify(pathSegments)}::${propertyName}`;
        (this.modifiedHandlers.get(registrationKey) ?? []).forEach(handler => handler(keyPath, key, oldValue, newValue));
    }
}

function getSeriesPoints(output: Array<{ series: string; items: Array<{ time: number; change: number; change2: number }> }>, series: string) {
    return output.find(row => row.series === series)?.items ?? [];
}

function normalizePoints(points: Array<{ time: number; change: number; change2?: number; note?: string }>) {
    return [...points]
        .sort((left, right) => left.time - right.time)
        .map(point => ({ time: point.time, change: point.change, change2: point.change2, note: point.note }));
}

describe('cumulativeSum (builder)', () => {
    function createCumulativePipeline() {
        return createPipeline<{
            series: string;
            time: number;
            change: number;
            change2: number;
            note: string;
        }, 'items'>('items', [
            { name: 'series', type: 'string' },
            { name: 'time', type: 'number' },
            { name: 'change', type: 'number' },
            { name: 'change2', type: 'number' },
            { name: 'note', type: 'string' }
        ])
            .groupBy(['series'], 'seriesGroups')
            // Mark cumulative inputs as mutable to satisfy AC12 and support onModified propagation.
            .in('items').defineProperty('change', point => point.change, ['change'])
            .in('items').defineProperty('change2', point => point.change2, ['change2'])
            .cumulativeSum('items', ['time'], ['change', 'change2']);
    }

    it('should produce cumulative values for a single item', () => {
        const [pipeline, getOutput] = createTestPipeline(createCumulativePipeline);

        pipeline.add('e1', { series: 'A', time: 1, change: 10, change2: 4, note: 'first' });

        const output = getOutput();
        const points = normalizePoints(getSeriesPoints(output, 'A'));
        expect(points).toEqual([
            { time: 1, change: 10, change2: 4, note: 'first' }
        ]);
    });

    it('should compute prefix sums across multiple sorted items', () => {
        const [pipeline, getOutput] = createTestPipeline(createCumulativePipeline);

        pipeline.add('e1', { series: 'A', time: 1, change: 10, change2: 2, note: 'one' });
        pipeline.add('e2', { series: 'A', time: 2, change: 5, change2: 3, note: 'two' });
        pipeline.add('e3', { series: 'A', time: 3, change: 7, change2: 4, note: 'three' });

        const points = normalizePoints(getSeriesPoints(getOutput(), 'A'));
        expect(points).toEqual([
            { time: 1, change: 10, change2: 2, note: 'one' },
            { time: 2, change: 15, change2: 5, note: 'two' },
            { time: 3, change: 22, change2: 9, note: 'three' }
        ]);
    });

    it('should update successors when an item is inserted in the middle and when removed', () => {
        const [pipeline, getOutput] = createTestPipeline(createCumulativePipeline);

        const t1 = { series: 'A', time: 1, change: 10, change2: 1, note: 't1' };
        const t3 = { series: 'A', time: 3, change: 5, change2: 2, note: 't3' };
        const t2 = { series: 'A', time: 2, change: 7, change2: 4, note: 't2' };

        pipeline.add('t1', t1);
        pipeline.add('t3', t3);
        expect(normalizePoints(getSeriesPoints(getOutput(), 'A'))).toEqual([
            { time: 1, change: 10, change2: 1, note: 't1' },
            { time: 3, change: 15, change2: 3, note: 't3' }
        ]);

        pipeline.add('t2', t2);
        expect(normalizePoints(getSeriesPoints(getOutput(), 'A'))).toEqual([
            { time: 1, change: 10, change2: 1, note: 't1' },
            { time: 2, change: 17, change2: 5, note: 't2' },
            { time: 3, change: 22, change2: 7, note: 't3' }
        ]);

        const beforeRemove = normalizePoints(getSeriesPoints(getOutput(), 'A'));
        pipeline.remove('t2', t2);
        const afterRemove = normalizePoints(getSeriesPoints(getOutput(), 'A'));

        expect(afterRemove).toEqual([
            { time: 1, change: 10, change2: 1, note: 't1' },
            { time: 3, change: 15, change2: 3, note: 't3' }
        ]);

        pipeline.add('t2', t2);
        pipeline.remove('t2', t2);
        expect(normalizePoints(getSeriesPoints(getOutput(), 'A'))).toEqual(afterRemove);
        expect(beforeRemove).not.toEqual(afterRemove);
    });

    it('should be commutative across insertion orders', () => {
        const [pipelineA, getOutputA] = createTestPipeline(createCumulativePipeline);
        const [pipelineB, getOutputB] = createTestPipeline(createCumulativePipeline);

        const events = [
            { key: 'e1', value: { series: 'A', time: 1, change: 10, change2: 2, note: 'one' } },
            { key: 'e2', value: { series: 'A', time: 2, change: 5, change2: 3, note: 'two' } },
            { key: 'e3', value: { series: 'A', time: 3, change: 7, change2: 4, note: 'three' } }
        ];

        events.forEach(event => pipelineA.add(event.key, event.value));
        [...events].reverse().forEach(event => pipelineB.add(event.key, event.value));

        expect(normalizePoints(getSeriesPoints(getOutputA(), 'A'))).toEqual(
            normalizePoints(getSeriesPoints(getOutputB(), 'A'))
        );
    });

    it('should produce no output for an empty collection', () => {
        const [_, getOutput] = createTestPipeline(createCumulativePipeline);
        expect(getOutput()).toEqual([]);
    });

    it('should reject non-mutable cumulative properties', () => {
        expect(() => createPipeline<{ series: string; time: number; change: number }, 'items'>('items', [
            { name: 'series', type: 'string' },
            { name: 'time', type: 'number' },
            { name: 'change', type: 'number' }
        ])
            .groupBy(['series'], 'seriesGroups')
            .cumulativeSum('items', ['time'], ['change'])
        ).toThrow('mutable');
    });

    it('should reject missing orderBy properties', () => {
        expect(() => createPipeline<{ series: string; time: number; change: number }, 'items'>('items', [
            { name: 'series', type: 'string' },
            { name: 'time', type: 'number' },
            { name: 'change', type: 'number' }
        ])
            .groupBy(['series'], 'seriesGroups')
            .in('items').defineProperty('change', point => point.change, ['change'])
            .cumulativeSum('items', ['missing'] as string[], ['change'])
        ).toThrow('orderBy');
    });

    it('should reject missing arrays in current scope', () => {
        expect(() => createPipeline<{ series: string; time: number; change: number }, 'items'>('items', [
            { name: 'series', type: 'string' },
            { name: 'time', type: 'number' },
            { name: 'change', type: 'number' }
        ])
            .groupBy(['series'], 'seriesGroups')
            .in('items').defineProperty('change', point => point.change, ['change'])
            .cumulativeSum('missing' as string, ['time'], ['change'])
        ).toThrow('array');
    });

    it('should allow cumulativeSum over mutable properties introduced by defineProperty', () => {
        expect(() => createPipeline<{
            series: string;
            time: number;
            change: number;
        }, 'items'>('items', [
            { name: 'series', type: 'string' },
            { name: 'time', type: 'number' },
            { name: 'change', type: 'number' }
        ])
            .groupBy(['series'], 'seriesGroups')
            .in('items').defineProperty('derivedChange', point => point.change, ['change'])
            .cumulativeSum('items', ['time'], ['derivedChange'])
        ).not.toThrow();
    });
});

describe('CumulativeSumStep (incremental behavior)', () => {
    function createStepHarness() {
        const fakeInput = new FakeInputStep({
            rootCollectionName: 'groups',
            arrays: [
                {
                    name: 'items',
                    type: {
                        arrays: [],
                        collectionKey: [],
                        scalars: [
                            { name: 'order', type: 'number' },
                            { name: 'value', type: 'number' },
                            { name: 'label', type: 'string' }
                        ],
                        objects: [],
                        mutableProperties: ['order', 'value', 'label']
                    }
                }
            ],
            collectionKey: [],
            scalars: [],
            objects: [],
            mutableProperties: []
        });

        const step = new CumulativeSumStep(
            fakeInput,
            ['items'],
            ['order'],
            ['value']
        );

        const modified: ModifiedEvent[] = [];
        step.onModified(['items'], 'value', (keyPath, key, oldValue, newValue) => {
            modified.push({ keyPath, key, oldValue, newValue });
        });

        return { fakeInput, step, modified };
    }

    it('should propagate cumulative value modifications through suffix on input value change', () => {
        const { fakeInput, modified } = createStepHarness();

        fakeInput.emitAdded(['items'], [], 'i1', { order: 1, value: 10, label: 'A' });
        fakeInput.emitAdded(['items'], [], 'i2', { order: 2, value: 5, label: 'B' });
        modified.length = 0;

        fakeInput.emitModified(['items'], 'value', [], 'i1', 10, 13);

        expect(modified).toEqual([
            { keyPath: [], key: 'i1', oldValue: 10, newValue: 13 },
            { keyPath: [], key: 'i2', oldValue: 15, newValue: 18 }
        ]);
    });

    it('should emit no cumulative modifications for zero-delta value changes', () => {
        const { fakeInput, modified } = createStepHarness();

        fakeInput.emitAdded(['items'], [], 'i1', { order: 1, value: 10, label: 'A' });
        fakeInput.emitAdded(['items'], [], 'i2', { order: 2, value: 5, label: 'B' });
        modified.length = 0;

        fakeInput.emitModified(['items'], 'value', [], 'i1', 10, 10);

        expect(modified).toEqual([]);
    });

    it('should forward non-cumulated property modifications unchanged', () => {
        const { fakeInput, step } = createStepHarness();

        const forwarded: ModifiedEvent[] = [];
        step.onModified(['items'], 'label', (keyPath, key, oldValue, newValue) => {
            forwarded.push({ keyPath, key, oldValue, newValue });
        });

        fakeInput.emitAdded(['items'], [], 'i1', { order: 1, value: 10, label: 'A' });
        fakeInput.emitModified(['items'], 'label', [], 'i1', 'A', 'B');

        expect(forwarded).toEqual([
            { keyPath: [], key: 'i1', oldValue: 'A', newValue: 'B' }
        ]);
    });
});
