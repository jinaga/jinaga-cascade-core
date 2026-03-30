import type {
    AddedHandler,
    ArrayDescriptor,
    BuildContext,
    BuiltStepGraph,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from '../pipeline.js';
import { pathsMatch } from '../util/path.js';
import { getDescriptorFromFactory } from '../step-builder-utils.js';

interface EventRecord {
    immutableProps: ImmutableProps;
    mutableValues: Map<string, unknown>;
}

interface EntityState {
    eventsByKey: Map<string, EventRecord>;
    sortedEventKeys: string[];
}

function computeKeyPathHash(keyPath: string[]): string {
    return keyPath.join('::');
}

function finiteNumericValue(value: unknown): number {
    if (value === null || value === undefined) {
        return 0;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function comparePrimitiveValues(left: unknown, right: unknown): number {
    if (typeof left === 'number' && typeof right === 'number') {
        return left - right;
    }
    if (typeof left === 'string' && typeof right === 'string') {
        if (left < right) {
            return -1;
        }
        if (left > right) {
            return 1;
        }
        return 0;
    }
    if (typeof left === 'boolean' && typeof right === 'boolean') {
        if (left === right) {
            return 0;
        }
        return left ? 1 : -1;
    }
    const leftAsString = String(left);
    const rightAsString = String(right);
    if (leftAsString < rightAsString) {
        return -1;
    }
    if (leftAsString > rightAsString) {
        return 1;
    }
    return 0;
}

function navigateToArrayDescriptor(
    descriptor: DescriptorNode,
    segmentPath: string[]
): ArrayDescriptor | undefined {
    if (segmentPath.length === 0) {
        return undefined;
    }

    let current: DescriptorNode = descriptor;
    for (let i = 0; i < segmentPath.length; i++) {
        const segment = segmentPath[i];
        const arrayDescriptor = current.arrays.find(array => array.name === segment);
        if (!arrayDescriptor) {
            return undefined;
        }
        if (i === segmentPath.length - 1) {
            return arrayDescriptor;
        }
        current = arrayDescriptor.type;
    }
    return undefined;
}

function addOutputPropertiesAtPath(
    descriptor: DescriptorNode,
    entitySegmentPath: string[],
    eventArrayName: string,
    outputProperties: string[]
): DescriptorNode {
    if (entitySegmentPath.length === 0) {
        return {
            ...descriptor,
            arrays: descriptor.arrays.map(arrayDescriptor => {
                if (arrayDescriptor.name !== eventArrayName) {
                    return arrayDescriptor;
                }
                return {
                    ...arrayDescriptor,
                    type: addOutputPropertiesToEventNode(arrayDescriptor.type, outputProperties)
                };
            })
        };
    }

    const [head, ...tail] = entitySegmentPath;
    return {
        ...descriptor,
        arrays: descriptor.arrays.map(arrayDescriptor => {
            if (arrayDescriptor.name !== head) {
                return arrayDescriptor;
            }
            return {
                ...arrayDescriptor,
                type: addOutputPropertiesAtPath(arrayDescriptor.type, tail, eventArrayName, outputProperties)
            };
        })
    };
}

function addOutputPropertiesToEventNode(node: DescriptorNode, outputProperties: string[]): DescriptorNode {
    const nextScalars = [...node.scalars];
    const nextMutableProperties = [...node.mutableProperties];

    for (const outputProperty of outputProperties) {
        if (!nextScalars.some(scalar => scalar.name === outputProperty)) {
            nextScalars.push({ name: outputProperty, type: 'number' });
        }
        if (!nextMutableProperties.includes(outputProperty)) {
            nextMutableProperties.push(outputProperty);
        }
    }

    return {
        ...node,
        scalars: nextScalars,
        mutableProperties: nextMutableProperties
    };
}

/**
 * Converts absolute event values into per-event deltas relative to the predecessor
 * event within each entity's sorted event list.
 */
export class ReplaceToDeltaStep implements Step {
    private readonly eventSegmentPath: string[];
    private readonly propertyToOutput: Map<string, string>;
    private readonly outputPropertiesSet: Set<string>;
    private readonly orderBySet: Set<string>;

    private readonly entities: Map<string, EntityState> = new Map();
    private readonly addedHandlers: AddedHandler[] = [];
    private readonly removedHandlers: RemovedHandler[] = [];
    private readonly modifiedHandlersByProperty: Map<string, ModifiedHandler[]> = new Map();

    constructor(
        private readonly input: Step,
        private readonly entitySegmentPath: string[],
        private readonly eventArrayName: string,
        private readonly orderBy: string[],
        private readonly properties: string[],
        private readonly outputProperties: string[]
    ) {
        this.eventSegmentPath = [...entitySegmentPath, eventArrayName];
        this.validateConfiguration();

        this.propertyToOutput = new Map();
        this.properties.forEach((property, index) => {
            this.propertyToOutput.set(property, this.outputProperties[index]);
        });
        this.outputPropertiesSet = new Set(this.outputProperties);
        this.orderBySet = new Set(this.orderBy);

        this.input.onAdded(this.eventSegmentPath, (keyPath, key, immutableProps) => {
            this.handleEventAdded(keyPath, key, immutableProps);
        });
        this.input.onRemoved(this.eventSegmentPath, (keyPath, key, immutableProps) => {
            this.handleEventRemoved(keyPath, key, immutableProps);
        });
        for (const property of new Set([...this.properties, ...this.orderBy])) {
            this.input.onModified(this.eventSegmentPath, property, (keyPath, key, oldValue, newValue) => {
                this.handleTrackedPropertyModified(keyPath, key, property, oldValue, newValue);
            });
        }
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        return {
            ...addOutputPropertiesAtPath(
                inputDescriptor,
                this.entitySegmentPath,
                this.eventArrayName,
                this.outputProperties
            ),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.eventSegmentPath)) {
            this.addedHandlers.push(handler);
            return;
        }
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.eventSegmentPath)) {
            this.removedHandlers.push(handler);
            return;
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.eventSegmentPath) && this.outputPropertiesSet.has(propertyName)) {
            const handlers = this.modifiedHandlersByProperty.get(propertyName) ?? [];
            handlers.push(handler);
            this.modifiedHandlersByProperty.set(propertyName, handlers);
            return;
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    private validateConfiguration(): void {
        if (this.orderBy.length === 0) {
            throw new Error('ReplaceToDeltaStep requires at least one orderBy property.');
        }
        if (this.properties.length !== this.outputProperties.length) {
            throw new Error('ReplaceToDeltaStep requires properties and outputProperties to have equal length.');
        }
        const seenProperties = new Set<string>();
        for (const property of this.properties) {
            if (seenProperties.has(property)) {
                throw new Error(
                    `ReplaceToDeltaStep properties contains duplicate property "${property}".`
                );
            }
            seenProperties.add(property);
        }

        const inputDescriptor = this.input.getTypeDescriptor();
        const entityArrayDescriptor = navigateToArrayDescriptor(inputDescriptor, this.entitySegmentPath);
        if (!entityArrayDescriptor) {
            throw new Error(
                `ReplaceToDeltaStep could not find entity array at path [${this.entitySegmentPath.join('.')}] in descriptor.`
            );
        }
        const eventArrayDescriptor = entityArrayDescriptor.type.arrays.find(array => array.name === this.eventArrayName);
        if (!eventArrayDescriptor) {
            throw new Error(
                `ReplaceToDeltaStep could not find event array "${this.eventArrayName}" under entity path [${this.entitySegmentPath.join('.')}] in descriptor.`
            );
        }

        const eventScalarNames = new Set(eventArrayDescriptor.type.scalars.map(scalar => scalar.name));
        const hasEventScalarMetadata = eventArrayDescriptor.type.scalars.length > 0;
        const knownEventPropertyNames = new Set<string>([...this.orderBy, ...this.properties]);
        if (hasEventScalarMetadata) {
            for (const orderProperty of this.orderBy) {
                if (!eventScalarNames.has(orderProperty)) {
                    throw new Error(
                        `ReplaceToDeltaStep orderBy property "${orderProperty}" is not a scalar on event type "${this.eventArrayName}".`
                    );
                }
            }
            for (const property of this.properties) {
                if (!eventScalarNames.has(property)) {
                    throw new Error(
                        `ReplaceToDeltaStep property "${property}" is not a scalar on event type "${this.eventArrayName}".`
                    );
                }
            }
        }
        for (const collectionKeyPart of eventArrayDescriptor.type.collectionKey) {
            if (!this.orderBy.includes(collectionKeyPart)) {
                throw new Error(
                    `ReplaceToDeltaStep orderBy must include collectionKey property "${collectionKeyPart}" for event type "${this.eventArrayName}".`
                );
            }
        }
        const seenOutputProperties = new Set<string>();
        for (const outputProperty of this.outputProperties) {
            if (knownEventPropertyNames.has(outputProperty)) {
                throw new Error(
                    `ReplaceToDeltaStep output property "${outputProperty}" collides with an existing event property.`
                );
            }
            if (hasEventScalarMetadata && eventScalarNames.has(outputProperty)) {
                throw new Error(
                    `ReplaceToDeltaStep output property "${outputProperty}" collides with an existing scalar on event type "${this.eventArrayName}".`
                );
            }
            if (seenOutputProperties.has(outputProperty)) {
                throw new Error(
                    `ReplaceToDeltaStep output property "${outputProperty}" is duplicated in outputProperties.`
                );
            }
            seenOutputProperties.add(outputProperty);
        }
    }

    private handleEventAdded(parentKeyPath: string[], eventKey: string, immutableProps: ImmutableProps): void {
        const entity = this.getOrCreateEntity(parentKeyPath);

        const existingRecord = entity.eventsByKey.get(eventKey);
        if (existingRecord) {
            this.handleEventRemoved(parentKeyPath, eventKey, existingRecord.immutableProps);
        }

        const record: EventRecord = {
            immutableProps,
            mutableValues: new Map()
        };
        entity.eventsByKey.set(eventKey, record);

        const insertIndex = this.insertEventKey(entity, eventKey);
        const predecessor = insertIndex > 0
            ? entity.eventsByKey.get(entity.sortedEventKeys[insertIndex - 1])
            : undefined;
        const successorKey = insertIndex < entity.sortedEventKeys.length - 1
            ? entity.sortedEventKeys[insertIndex + 1]
            : undefined;

        const deltas = this.computeAllDeltas(record, predecessor);
        this.emitAdded(parentKeyPath, eventKey, immutableProps, deltas);

        if (successorKey) {
            this.emitSuccessorDeltaChanges(parentKeyPath, successorKey, predecessor, record);
        }
    }

    private handleEventRemoved(parentKeyPath: string[], eventKey: string, immutableProps: ImmutableProps): void {
        const entityHash = computeKeyPathHash(parentKeyPath);
        const entity = this.entities.get(entityHash);
        if (!entity) {
            const fallbackRecord: EventRecord = {
                immutableProps,
                mutableValues: new Map()
            };
            this.emitRemoved(parentKeyPath, eventKey, immutableProps, this.computeAllDeltas(fallbackRecord, undefined));
            return;
        }

        const eventIndex = entity.sortedEventKeys.indexOf(eventKey);
        if (eventIndex < 0) {
            const fallbackRecord: EventRecord = {
                immutableProps,
                mutableValues: new Map()
            };
            this.emitRemoved(parentKeyPath, eventKey, immutableProps, this.computeAllDeltas(fallbackRecord, undefined));
            return;
        }

        const record = entity.eventsByKey.get(eventKey) ?? {
            immutableProps,
            mutableValues: new Map()
        };
        const predecessor = eventIndex > 0
            ? entity.eventsByKey.get(entity.sortedEventKeys[eventIndex - 1])
            : undefined;
        const successorKey = eventIndex < entity.sortedEventKeys.length - 1
            ? entity.sortedEventKeys[eventIndex + 1]
            : undefined;

        if (successorKey) {
            this.emitSuccessorDeltaChanges(parentKeyPath, successorKey, record, predecessor);
        }

        entity.sortedEventKeys.splice(eventIndex, 1);
        entity.eventsByKey.delete(eventKey);
        if (entity.sortedEventKeys.length === 0) {
            this.entities.delete(entityHash);
        }

        const deltas = this.computeAllDeltas(record, predecessor);
        this.emitRemoved(parentKeyPath, eventKey, record.immutableProps, deltas);
    }

    private handleTrackedPropertyModified(
        parentKeyPath: string[],
        eventKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        if (this.orderBySet.has(propertyName)) {
            this.handleOrderByPropertyModified(parentKeyPath, eventKey, propertyName, newValue);
            return;
        }
        this.handleValuePropertyModified(parentKeyPath, eventKey, propertyName, oldValue, newValue);
    }

    private handleValuePropertyModified(
        parentKeyPath: string[],
        eventKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        const outputProperty = this.propertyToOutput.get(propertyName);
        if (!outputProperty) {
            return;
        }

        const entity = this.entities.get(computeKeyPathHash(parentKeyPath));
        if (!entity) {
            return;
        }
        const record = entity.eventsByKey.get(eventKey);
        if (!record) {
            return;
        }

        const eventIndex = entity.sortedEventKeys.indexOf(eventKey);
        if (eventIndex < 0) {
            return;
        }

        const predecessor = eventIndex > 0
            ? entity.eventsByKey.get(entity.sortedEventKeys[eventIndex - 1])
            : undefined;
        const successorKey = eventIndex < entity.sortedEventKeys.length - 1
            ? entity.sortedEventKeys[eventIndex + 1]
            : undefined;

        const predecessorValue = predecessor
            ? this.getNumericPropertyValue(predecessor, propertyName)
            : 0;
        const oldDelta = finiteNumericValue(oldValue) - predecessorValue;
        const newDelta = finiteNumericValue(newValue) - predecessorValue;

        record.mutableValues.set(propertyName, newValue);

        if (!Object.is(oldDelta, newDelta)) {
            this.emitModified(parentKeyPath, eventKey, outputProperty, oldDelta, newDelta);
        }

        if (successorKey) {
            const successor = entity.eventsByKey.get(successorKey);
            if (!successor) {
                return;
            }
            const successorValue = this.getNumericPropertyValue(successor, propertyName);
            const oldSuccessorDelta = successorValue - finiteNumericValue(oldValue);
            const newSuccessorDelta = successorValue - finiteNumericValue(newValue);
            if (!Object.is(oldSuccessorDelta, newSuccessorDelta)) {
                this.emitModified(parentKeyPath, successorKey, outputProperty, oldSuccessorDelta, newSuccessorDelta);
            }
        }
    }

    private handleOrderByPropertyModified(
        parentKeyPath: string[],
        eventKey: string,
        propertyName: string,
        newValue: unknown
    ): void {
        const entity = this.entities.get(computeKeyPathHash(parentKeyPath));
        if (!entity) {
            return;
        }
        const record = entity.eventsByKey.get(eventKey);
        if (!record) {
            return;
        }
        const eventIndex = entity.sortedEventKeys.indexOf(eventKey);
        if (eventIndex < 0) {
            return;
        }

        const previousSnapshot = this.snapshotEntityDeltas(entity);

        record.mutableValues.set(propertyName, newValue);
        entity.sortedEventKeys.splice(eventIndex, 1);
        this.insertEventKey(entity, eventKey);

        const nextSnapshot = this.snapshotEntityDeltas(entity);
        this.emitDeltaSnapshotChanges(parentKeyPath, previousSnapshot, nextSnapshot);
    }

    private emitSuccessorDeltaChanges(
        parentKeyPath: string[],
        successorKey: string,
        oldPredecessor: EventRecord | undefined,
        newPredecessor: EventRecord | undefined
    ): void {
        const entity = this.entities.get(computeKeyPathHash(parentKeyPath));
        if (!entity) {
            return;
        }
        const successorRecord = entity.eventsByKey.get(successorKey);
        if (!successorRecord) {
            return;
        }

        this.properties.forEach((propertyName, index) => {
            const outputProperty = this.outputProperties[index];
            const oldDelta = this.computeDeltaForProperty(successorRecord, oldPredecessor, propertyName);
            const newDelta = this.computeDeltaForProperty(successorRecord, newPredecessor, propertyName);
            if (!Object.is(oldDelta, newDelta)) {
                this.emitModified(parentKeyPath, successorKey, outputProperty, oldDelta, newDelta);
            }
        });
    }

    private emitAdded(
        parentKeyPath: string[],
        eventKey: string,
        immutableProps: ImmutableProps,
        deltas: Record<string, number>
    ): void {
        const augmentedProps: ImmutableProps = {
            ...immutableProps,
            ...deltas
        };
        this.addedHandlers.forEach(handler => {
            handler(parentKeyPath, eventKey, augmentedProps);
        });
    }

    private emitRemoved(
        parentKeyPath: string[],
        eventKey: string,
        immutableProps: ImmutableProps,
        deltas: Record<string, number>
    ): void {
        const augmentedProps: ImmutableProps = {
            ...immutableProps,
            ...deltas
        };
        this.removedHandlers.forEach(handler => {
            handler(parentKeyPath, eventKey, augmentedProps);
        });
    }

    private emitModified(
        parentKeyPath: string[],
        eventKey: string,
        outputProperty: string,
        oldValue: number,
        newValue: number
    ): void {
        const handlers = this.modifiedHandlersByProperty.get(outputProperty) ?? [];
        handlers.forEach(handler => {
            handler(parentKeyPath, eventKey, oldValue, newValue);
        });
    }

    private snapshotEntityDeltas(entity: EntityState): Map<string, Record<string, number>> {
        const snapshot = new Map<string, Record<string, number>>();
        let predecessor: EventRecord | undefined;
        for (const key of entity.sortedEventKeys) {
            const record = entity.eventsByKey.get(key);
            if (!record) {
                continue;
            }
            snapshot.set(key, this.computeAllDeltas(record, predecessor));
            predecessor = record;
        }
        return snapshot;
    }

    private emitDeltaSnapshotChanges(
        parentKeyPath: string[],
        previousSnapshot: Map<string, Record<string, number>>,
        nextSnapshot: Map<string, Record<string, number>>
    ): void {
        for (const [key, nextDeltas] of nextSnapshot.entries()) {
            const previousDeltas = previousSnapshot.get(key);
            if (!previousDeltas) {
                continue;
            }
            for (const outputProperty of this.outputProperties) {
                const oldValue = previousDeltas[outputProperty];
                const newValue = nextDeltas[outputProperty];
                if (!Object.is(oldValue, newValue)) {
                    this.emitModified(parentKeyPath, key, outputProperty, oldValue, newValue);
                }
            }
        }
    }

    private getOrCreateEntity(parentKeyPath: string[]): EntityState {
        const entityHash = computeKeyPathHash(parentKeyPath);
        const existing = this.entities.get(entityHash);
        if (existing) {
            return existing;
        }
        const created: EntityState = {
            eventsByKey: new Map(),
            sortedEventKeys: []
        };
        this.entities.set(entityHash, created);
        return created;
    }

    private insertEventKey(entity: EntityState, eventKey: string): number {
        const sortedEventKeys = entity.sortedEventKeys;
        let low = 0;
        let high = sortedEventKeys.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const midKey = sortedEventKeys[mid];
            const comparison = this.compareEvents(entity, eventKey, midKey);
            if (comparison < 0) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        sortedEventKeys.splice(low, 0, eventKey);
        return low;
    }

    private compareEvents(entity: EntityState, leftKey: string, rightKey: string): number {
        const leftRecord = entity.eventsByKey.get(leftKey);
        const rightRecord = entity.eventsByKey.get(rightKey);
        if (!leftRecord || !rightRecord) {
            return leftKey.localeCompare(rightKey);
        }

        for (const orderProperty of this.orderBy) {
            const leftValue = this.getComparableOrderValue(leftRecord, orderProperty);
            const rightValue = this.getComparableOrderValue(rightRecord, orderProperty);
            const comparison = comparePrimitiveValues(leftValue, rightValue);
            if (comparison !== 0) {
                return comparison;
            }
        }

        return leftKey.localeCompare(rightKey);
    }

    private getComparableOrderValue(record: EventRecord, propertyName: string): unknown {
        if (record.mutableValues.has(propertyName)) {
            return record.mutableValues.get(propertyName);
        }
        return record.immutableProps[propertyName];
    }

    private getNumericPropertyValue(record: EventRecord, propertyName: string): number {
        if (record.mutableValues.has(propertyName)) {
            return finiteNumericValue(record.mutableValues.get(propertyName));
        }
        return finiteNumericValue(record.immutableProps[propertyName]);
    }

    private computeDeltaForProperty(
        current: EventRecord,
        predecessor: EventRecord | undefined,
        propertyName: string
    ): number {
        const currentValue = this.getNumericPropertyValue(current, propertyName);
        const predecessorValue = predecessor ? this.getNumericPropertyValue(predecessor, propertyName) : 0;
        return currentValue - predecessorValue;
    }

    private computeAllDeltas(
        current: EventRecord,
        predecessor: EventRecord | undefined
    ): Record<string, number> {
        const deltas: Record<string, number> = {};
        this.properties.forEach((propertyName, index) => {
            const outputProperty = this.outputProperties[index];
            deltas[outputProperty] = this.computeDeltaForProperty(current, predecessor, propertyName);
        });
        return deltas;
    }
}

export class ReplaceToDeltaBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private entitySegmentPath: string[],
        private eventArrayName: string,
        private orderBy: string[],
        private properties: string[],
        private outputProperties: string[]
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return getDescriptorFromFactory(
            this.upstream.getTypeDescriptor(),
            input => new ReplaceToDeltaStep(input, this.entitySegmentPath, this.eventArrayName, this.orderBy, this.properties, this.outputProperties)
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new ReplaceToDeltaStep(up.lastStep, this.entitySegmentPath, this.eventArrayName, this.orderBy, this.properties, this.outputProperties)
        };
    }
}
