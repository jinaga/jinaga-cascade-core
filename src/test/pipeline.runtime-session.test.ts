// @ts-nocheck
import { createPipeline, type KeyedArray, type Transform } from '../index';

describe('pipeline runtime sessions', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function createStateStore<T>() {
        let state: KeyedArray<T> = [];
        return {
            getState: () => state,
            setState: (transform: Transform<KeyedArray<T>>) => {
                state = transform(state);
            },
            reset: () => {
                state = [];
            }
        };
    }

    it('keeps co-existing pipelines isolated under interleaved events', () => {
        type RowA = { group: string; value: number };
        type RowB = { category: string; score: number };

        const storeA = createStateStore<any>();
        const storeB = createStateStore<any>();

        const sessionA = createPipeline<RowA>()
            .groupBy(['group'], 'groups')
            .build(storeA.setState, { flushDelayMs: 100 });

        const sessionB = createPipeline<RowB>()
            .groupBy(['category'], 'categories')
            .build(storeB.setState, { flushDelayMs: 100 });

        sessionA.add('a1', { group: 'G1', value: 10 });
        sessionB.add('b1', { category: 'C1', score: 100 });
        sessionA.add('a2', { group: 'G2', value: 20 });
        sessionB.add('b2', { category: 'C1', score: 200 });

        sessionA.flush();
        sessionB.flush();

        expect(storeA.getState().length).toBe(2);
        expect(storeB.getState().length).toBe(1);
        expect(storeA.getState().some(item => item.value.group === 'G1')).toBe(true);
        expect(storeB.getState()[0].value.category).toBe('C1');
    });

    it('dispose({ flush: false }) drops pending operations deterministically', () => {
        type Row = { group: string; value: number };
        const store = createStateStore<any>();

        const session = createPipeline<Row>()
            .groupBy(['group'], 'groups')
            .build(store.setState, { flushDelayMs: 1000 });

        session.add('a1', { group: 'G1', value: 10 });
        session.dispose();
        jest.runOnlyPendingTimers();

        expect(store.getState()).toEqual([]);
        expect(session.isDisposed()).toBe(true);
    });

    it('dispose({ flush: true }) drains pending operations before closing', () => {
        type Row = { group: string; value: number };
        const store = createStateStore<any>();

        const session = createPipeline<Row>()
            .groupBy(['group'], 'groups')
            .build(store.setState, { flushDelayMs: 1000 });

        session.add('a1', { group: 'G1', value: 10 });
        session.dispose({ flush: true });

        expect(store.getState().length).toBe(1);
        expect(store.getState()[0].value.group).toBe('G1');
        expect(session.isDisposed()).toBe(true);
    });

    it('drops operations after dispose and emits diagnostics instead of mutating state', () => {
        type Row = { group: string; value: number };
        const store = createStateStore<any>();
        const diagnostics: string[] = [];

        const session = createPipeline<Row>()
            .groupBy(['group'], 'groups')
            .build(store.setState, {
                flushDelayMs: 100,
                onDiagnostic: diagnostic => diagnostics.push(diagnostic.code)
            });

        session.dispose();
        session.add('a1', { group: 'G1', value: 10 });
        jest.runOnlyPendingTimers();

        expect(store.getState()).toEqual([]);
        expect(diagnostics).toContain('operation_after_dispose');
    });

    it('drops missing-parent nested adds and emits diagnostics', () => {
        type Row = { attendeePublicKey: string; round: number; amount: number };
        const resilientStore = createStateStore<any>();
        const resilientDiagnostics: string[] = [];

        const resilientSession = createPipeline<Row, 'allocations'>('allocations')
            .groupBy(['attendeePublicKey'], 'attendees')
            .in('allocations')
            .groupBy(['round'], 'rounds')
            .build(resilientStore.setState, {
                flushDelayMs: 1000,
                onDiagnostic: diagnostic => resilientDiagnostics.push(diagnostic.code)
            });

        // Seed parent hierarchy.
        resilientSession.add('r1', { attendeePublicKey: 'p1', round: 1, amount: 10 });
        resilientSession.flush();

        // Queue nested add and then clear external state before flush to simulate teardown/reset race.
        resilientSession.add('r2', { attendeePublicKey: 'p1', round: 2, amount: 20 });
        resilientStore.reset();
        expect(() => jest.runOnlyPendingTimers()).not.toThrow();
        expect(resilientDiagnostics).toContain('missing_parent_add_dropped');
    });
});

