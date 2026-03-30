// @ts-nocheck
import { createPipeline, type DescriptorNode, type TypeDescriptor } from '../index';
import { createTestPipeline } from './helpers';
import { ReplaceToDeltaStep } from '../steps/replace-to-delta';
import type { ImmutableProps, ModifiedHandler, Step } from '../pipeline';

type AllocationRow = {
    effectiveClass: string;
    attendeeId: string;
    createdAt: string;
    eventId: string;
    amount: number;
    bonus: number;
};

type DeltaEvent = {
    createdAt: string;
    eventId: string;
    amount: number;
    bonus: number;
    deltaAmount: number;
    deltaBonus: number;
};

function buildReplaceToDeltaPipeline() {
    return createPipeline<AllocationRow>()
        .groupBy(['effectiveClass'], 'attendees')
        .in('items').groupBy(['attendeeId'], 'attendees')
        .replaceToDelta(
            'attendees',
            'items',
            ['createdAt', 'eventId'],
            ['amount', 'bonus'],
            ['deltaAmount', 'deltaBonus']
        );
}

function sortEvents(events: DeltaEvent[]): DeltaEvent[] {
    return [...events].sort((left, right) => {
        if (left.createdAt < right.createdAt) {
            return -1;
        }
        if (left.createdAt > right.createdAt) {
            return 1;
        }
        if (left.eventId < right.eventId) {
            return -1;
        }
        if (left.eventId > right.eventId) {
            return 1;
        }
        return 0;
    });
}

function getAttendeeEvents(
    output: Array<{
        effectiveClass: string;
        attendees: Array<{
            attendeeId: string;
            items: DeltaEvent[];
        }>;
    }>,
    effectiveClass: string,
    attendeeId: string
): DeltaEvent[] {
    const classRow = output.find(row => row.effectiveClass === effectiveClass);
    expect(classRow).toBeDefined();
    const attendeeRow = classRow?.attendees.find(row => row.attendeeId === attendeeId);
    expect(attendeeRow).toBeDefined();
    return sortEvents(attendeeRow?.items ?? []);
}

function normalizeOutput(
    output: Array<{
        effectiveClass: string;
        attendees: Array<{
            attendeeId: string;
            items: DeltaEvent[];
        }>;
    }>
) {
    return output
        .map(classRow => ({
            ...classRow,
            attendees: classRow.attendees
                .map(attendee => ({
                    ...attendee,
                    items: sortEvents(attendee.items)
                }))
                .sort((left, right) => left.attendeeId.localeCompare(right.attendeeId))
        }))
        .sort((left, right) => left.effectiveClass.localeCompare(right.effectiveClass));
}

type AddedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;
type RemovedHandler = (keyPath: string[], key: string, immutableProps: ImmutableProps) => void;

class FakeStep implements Step {
    private readonly addedHandlers = new Map<string, AddedHandler[]>();
    private readonly removedHandlers = new Map<string, RemovedHandler[]>();
    private readonly modifiedHandlers = new Map<string, ModifiedHandler[]>();

    constructor(readonly descriptor: TypeDescriptor) {}

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        const key = JSON.stringify(pathSegments);
        const handlers = this.addedHandlers.get(key) ?? [];
        handlers.push(handler);
        this.addedHandlers.set(key, handlers);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        const key = JSON.stringify(pathSegments);
        const handlers = this.removedHandlers.get(key) ?? [];
        handlers.push(handler);
        this.removedHandlers.set(key, handlers);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        const key = `${JSON.stringify(pathSegments)}::${propertyName}`;
        const handlers = this.modifiedHandlers.get(key) ?? [];
        handlers.push(handler);
        this.modifiedHandlers.set(key, handlers);
    }

    emitAdded(pathSegments: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        const handlers = this.addedHandlers.get(JSON.stringify(pathSegments)) ?? [];
        handlers.forEach(handler => handler(keyPath, key, immutableProps));
    }

    emitRemoved(pathSegments: string[], keyPath: string[], key: string, immutableProps: ImmutableProps): void {
        const handlers = this.removedHandlers.get(JSON.stringify(pathSegments)) ?? [];
        handlers.forEach(handler => handler(keyPath, key, immutableProps));
    }

    emitModified(
        pathSegments: string[],
        propertyName: string,
        keyPath: string[],
        key: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        const handlers = this.modifiedHandlers.get(`${JSON.stringify(pathSegments)}::${propertyName}`) ?? [];
        handlers.forEach(handler => handler(keyPath, key, oldValue, newValue));
    }
}

function fakeDescriptorForReplaceToDelta(eventCollectionKey: string[]): TypeDescriptor {
    const eventNode: DescriptorNode = {
        arrays: [],
        collectionKey: eventCollectionKey,
        scalars: [
            { name: 'time', type: 'number' },
            { name: 'id', type: 'string' },
            { name: 'amount', type: 'number' }
        ],
        objects: [],
        mutableProperties: ['amount']
    };
    return {
        rootCollectionName: 'root',
        collectionKey: [],
        scalars: [],
        objects: [],
        mutableProperties: [],
        arrays: [
            {
                name: 'entities',
                type: {
                    arrays: [
                        {
                            name: 'events',
                            type: eventNode
                        }
                    ],
                    collectionKey: ['entityId'],
                    scalars: [{ name: 'entityId', type: 'string' }],
                    objects: [],
                    mutableProperties: []
                }
            }
        ]
    };
}

describe('pipeline replaceToDelta', () => {
    it('should compute first-event baseline and predecessor deltas while preserving originals', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildReplaceToDeltaPipeline());

        pipeline.add('e1', {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-10T00:00:00.000Z',
            eventId: 'E1',
            amount: 10,
            bonus: 2
        });
        pipeline.add('e2', {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-11T00:00:00.000Z',
            eventId: 'E2',
            amount: 15,
            bonus: 3
        });

        const events = getAttendeeEvents(getOutput(), 'C1', 'A1');
        expect(events).toEqual([
            {
                createdAt: '2026-03-10T00:00:00.000Z',
                eventId: 'E1',
                amount: 10,
                bonus: 2,
                deltaAmount: 10,
                deltaBonus: 2
            },
            {
                createdAt: '2026-03-11T00:00:00.000Z',
                eventId: 'E2',
                amount: 15,
                bonus: 3,
                deltaAmount: 5,
                deltaBonus: 1
            }
        ]);
    });

    it('should recompute successor delta when inserting an event between two existing events', () => {
        const [pipeline, getOutput] = createTestPipeline(() => buildReplaceToDeltaPipeline());

        pipeline.add('e1', {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-10T00:00:00.000Z',
            eventId: 'E1',
            amount: 10,
            bonus: 1
        });
        pipeline.add('e3', {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-12T00:00:00.000Z',
            eventId: 'E3',
            amount: 25,
            bonus: 6
        });

        let events = getAttendeeEvents(getOutput(), 'C1', 'A1');
        expect(events[1].deltaAmount).toBe(15);
        expect(events[1].deltaBonus).toBe(5);

        pipeline.add('e2', {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-11T00:00:00.000Z',
            eventId: 'E2',
            amount: 18,
            bonus: 4
        });

        events = getAttendeeEvents(getOutput(), 'C1', 'A1');
        expect(events).toEqual([
            {
                createdAt: '2026-03-10T00:00:00.000Z',
                eventId: 'E1',
                amount: 10,
                bonus: 1,
                deltaAmount: 10,
                deltaBonus: 1
            },
            {
                createdAt: '2026-03-11T00:00:00.000Z',
                eventId: 'E2',
                amount: 18,
                bonus: 4,
                deltaAmount: 8,
                deltaBonus: 3
            },
            {
                createdAt: '2026-03-12T00:00:00.000Z',
                eventId: 'E3',
                amount: 25,
                bonus: 6,
                deltaAmount: 7,
                deltaBonus: 2
            }
        ]);
    });

    it('should converge to identical deltas regardless of add ordering', () => {
        const [pipelineA, getOutputA] = createTestPipeline(() => buildReplaceToDeltaPipeline());
        const [pipelineB, getOutputB] = createTestPipeline(() => buildReplaceToDeltaPipeline());

        const rows: AllocationRow[] = [
            {
                effectiveClass: 'C1',
                attendeeId: 'A1',
                createdAt: '2026-03-10T00:00:00.000Z',
                eventId: 'E1',
                amount: 10,
                bonus: 1
            },
            {
                effectiveClass: 'C1',
                attendeeId: 'A1',
                createdAt: '2026-03-11T00:00:00.000Z',
                eventId: 'E2',
                amount: 18,
                bonus: 4
            },
            {
                effectiveClass: 'C1',
                attendeeId: 'A1',
                createdAt: '2026-03-12T00:00:00.000Z',
                eventId: 'E3',
                amount: 25,
                bonus: 6
            }
        ];

        pipelineA.add('a2', rows[1]);
        pipelineA.add('a1', rows[0]);
        pipelineA.add('a3', rows[2]);

        pipelineB.add('b3', rows[2]);
        pipelineB.add('b2', rows[1]);
        pipelineB.add('b1', rows[0]);

        expect(normalizeOutput(getOutputA())).toEqual(normalizeOutput(getOutputB()));
    });

    it('should recompute successor delta after middle-event removal to match no-middle baseline', () => {
        const [withMiddle, getWithMiddle] = createTestPipeline(() => buildReplaceToDeltaPipeline());
        const [withoutMiddle, getWithoutMiddle] = createTestPipeline(() => buildReplaceToDeltaPipeline());

        const t1 = {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-10T00:00:00.000Z',
            eventId: 'E1',
            amount: 10,
            bonus: 1
        };
        const t2 = {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-11T00:00:00.000Z',
            eventId: 'E2',
            amount: 18,
            bonus: 4
        };
        const t3 = {
            effectiveClass: 'C1',
            attendeeId: 'A1',
            createdAt: '2026-03-12T00:00:00.000Z',
            eventId: 'E3',
            amount: 25,
            bonus: 6
        };

        withMiddle.add('e1', t1);
        withMiddle.add('e2', t2);
        withMiddle.add('e3', t3);
        withMiddle.remove('e2', t2);

        withoutMiddle.add('e1', t1);
        withoutMiddle.add('e3', t3);

        expect(normalizeOutput(getWithMiddle())).toEqual(normalizeOutput(getWithoutMiddle()));
    });

    it('should reject mismatched properties/outputProperties lengths', () => {
        expect(() => {
            createPipeline<AllocationRow>()
                .groupBy(['effectiveClass'], 'attendees')
                .in('items').groupBy(['attendeeId'], 'attendees')
                .replaceToDelta(
                    'attendees',
                    'items',
                    ['createdAt', 'eventId'],
                    ['amount'],
                    ['deltaAmount', 'deltaBonus']
                );
        }).toThrow();
    });

    it('should reject output property collisions with existing event scalars', () => {
        expect(() => {
            createPipeline<AllocationRow>()
                .groupBy(['effectiveClass'], 'attendees')
                .in('items').groupBy(['attendeeId'], 'attendees')
                .replaceToDelta(
                    'attendees',
                    'items',
                    ['createdAt', 'eventId'],
                    ['amount'],
                    ['amount']
                );
        }).toThrow();
    });

    it('should reject duplicate properties with a meaningful error', () => {
        expect(() => {
            createPipeline<AllocationRow>()
                .groupBy(['effectiveClass'], 'attendees')
                .in('items').groupBy(['attendeeId'], 'attendees')
                .replaceToDelta(
                    'attendees',
                    'items',
                    ['createdAt', 'eventId'],
                    ['amount', 'amount'],
                    ['deltaAmountA', 'deltaAmountB']
                );
        }).toThrow('duplicate');
    });
});

describe('ReplaceToDeltaStep internals', () => {
    it('should update both the modified event delta and its successor delta', () => {
        const fakeInput = new FakeStep(fakeDescriptorForReplaceToDelta(['id']));
        const step = new ReplaceToDeltaStep(
            fakeInput,
            ['entities'],
            'events',
            ['time', 'id'],
            ['amount'],
            ['delta'],
            fakeInput.descriptor
        );

        const modifiedEvents: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
        step.onModified(['entities', 'events'], 'delta', (keyPath, key, oldValue, newValue) => {
            expect(keyPath).toEqual(['entity-1']);
            modifiedEvents.push({ key, oldValue, newValue });
        });

        fakeInput.emitAdded(['entities'], [], 'entity-1', { entityId: 'E1' });
        fakeInput.emitAdded(['entities', 'events'], ['entity-1'], 'event-1', { time: 1, id: 't1', amount: 10 });
        fakeInput.emitAdded(['entities', 'events'], ['entity-1'], 'event-2', { time: 2, id: 't2', amount: 15 });

        fakeInput.emitModified(['entities', 'events'], 'amount', ['entity-1'], 'event-1', 10, 12);

        expect(modifiedEvents).toEqual([
            { key: 'event-1', oldValue: 10, newValue: 12 },
            { key: 'event-2', oldValue: 5, newValue: 3 }
        ]);
    });

    it('should reject orderBy when it does not cover event collectionKey', () => {
        const fakeInput = new FakeStep(fakeDescriptorForReplaceToDelta(['id']));

        expect(() => {
            new ReplaceToDeltaStep(
                fakeInput,
                ['entities'],
                'events',
                ['time'],
                ['amount'],
                ['delta'],
                fakeInput.descriptor
            );
        }).toThrow();
    });

    it('should recompute deltas when a mutable orderBy field changes', () => {
        const fakeInput = new FakeStep(fakeDescriptorForReplaceToDelta(['id']));
        const step = new ReplaceToDeltaStep(
            fakeInput,
            ['entities'],
            'events',
            ['time', 'id'],
            ['amount'],
            ['delta'],
            fakeInput.descriptor
        );

        const modifiedEvents: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
        step.onModified(['entities', 'events'], 'delta', (_keyPath, key, oldValue, newValue) => {
            modifiedEvents.push({ key, oldValue, newValue });
        });

        fakeInput.emitAdded(['entities'], [], 'entity-1', { entityId: 'E1' });
        fakeInput.emitAdded(['entities', 'events'], ['entity-1'], 'event-1', { time: 1, id: 't1', amount: 10 });
        fakeInput.emitAdded(['entities', 'events'], ['entity-1'], 'event-2', { time: 2, id: 't2', amount: 15 });

        // Move event-1 after event-2 by changing mutable orderBy field.
        // Expected:
        // - event-2 becomes baseline delta: 15 (from previous 5)
        // - event-1 becomes successor delta: -5 (from previous 10)
        fakeInput.emitModified(['entities', 'events'], 'time', ['entity-1'], 'event-1', 1, 3);

        expect(modifiedEvents).toContainEqual({ key: 'event-2', oldValue: 5, newValue: 15 });
        expect(modifiedEvents).toContainEqual({ key: 'event-1', oldValue: 10, newValue: -5 });
    });
});
