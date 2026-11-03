import type {
    AddedHandler,
    ArrayDescriptor,
    BuildContext,
    BuiltStepGraph,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    PlacedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from '../pipeline.js';
import { pathsMatch } from '../util/path.js';

interface EventRecord {
    /** Key of the entity the event belongs to. */
    parentKey: string;
    immutableProps: ImmutableProps;
    mutableValues: Map<string, unknown>;
}

interface EntityState {
    /** Keys of the entity's events in sort order. */
    sortedEventKeys: string[];
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

function validateReplaceToDeltaConfiguration(
    inputDescriptor: TypeDescriptor,
    entitySegmentPath: string[],
    eventArrayName: string,
    orderBy: string[],
    properties: string[],
    outputProperties: string[]
): void {
    if (orderBy.length === 0) {
        throw new Error('ReplaceToDeltaStep requires at least one orderBy property.');
    }
    if (properties.length !== outputProperties.length) {
        throw new Error('ReplaceToDeltaStep requires properties and outputProperties to have equal length.');
    }
    const seenProperties = new Set<string>();
    for (const property of properties) {
        if (seenProperties.has(property)) {
            throw new Error(
                `ReplaceToDeltaStep properties contains duplicate property "${property}".`
            );
        }
        seenProperties.add(property);
    }

    const entityArrayDescriptor = navigateToArrayDescriptor(inputDescriptor, entitySegmentPath);
    if (!entityArrayDescriptor) {
        throw new Error(
            `ReplaceToDeltaStep could not find entity array at path [${entitySegmentPath.join('.')}] in descriptor.`
        );
    }
    const eventArrayDescriptor = entityArrayDescriptor.type.arrays.find(array => array.name === eventArrayName);
    if (!eventArrayDescriptor) {
        throw new Error(
            `ReplaceToDeltaStep could not find event array "${eventArrayName}" under entity path [${entitySegmentPath.join('.')}] in descriptor.`
        );
    }

    const eventScalarNames = new Set(eventArrayDescriptor.type.scalars.map(scalar => scalar.name));
    const hasEventScalarMetadata = eventArrayDescriptor.type.scalars.length > 0;
    const knownEventPropertyNames = new Set<string>([...orderBy, ...properties]);
    if (hasEventScalarMetadata) {
        for (const orderProperty of orderBy) {
            if (!eventScalarNames.has(orderProperty)) {
                throw new Error(
                    `ReplaceToDeltaStep orderBy property "${orderProperty}" is not a scalar on event type "${eventArrayName}".`
                );
            }
        }
        for (const property of properties) {
            if (!eventScalarNames.has(property)) {
                throw new Error(
                    `ReplaceToDeltaStep property "${property}" is not a scalar on event type "${eventArrayName}".`
                );
            }
        }
    }
    for (const collectionKeyPart of eventArrayDescriptor.type.collectionKey) {
        if (!orderBy.includes(collectionKeyPart)) {
            throw new Error(
                `ReplaceToDeltaStep orderBy must include collectionKey property "${collectionKeyPart}" for event type "${eventArrayName}".`
            );
        }
    }
    const seenOutputProperties = new Set<string>();
    for (const outputProperty of outputProperties) {
        if (knownEventPropertyNames.has(outputProperty)) {
            throw new Error(
                `ReplaceToDeltaStep output property "${outputProperty}" collides with an existing event property.`
            );
        }
        if (hasEventScalarMetadata && eventScalarNames.has(outputProperty)) {
            throw new Error(
                `ReplaceToDeltaStep output property "${outputProperty}" collides with an existing scalar on event type "${eventArrayName}".`
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

/**
 * Converts absolute event values into per-event deltas relative to the predecessor
 * event within each entity's sorted event list.
 */
export class ReplaceToDeltaStep implements Step {
    private readonly eventSegmentPath: string[];
    private readonly propertyToOutput: Map<string, string>;
    private readonly outputPropertiesSet: Set<string>;
    private readonly orderBySet: Set<string>;

    private readonly events: Map<string, EventRecord> = new Map();
    private readonly entities: Map<string, EntityState> = new Map();
    private readonly addedHandlers: AddedHandler[] = [];
    private readonly removedHandlers: RemovedHandler[] = [];
    private readonly placedHandlers: PlacedHandler[] = [];
    private readonly modifiedHandlersByProperty: Map<string, ModifiedHandler[]> = new Map();

    constructor(
        private readonly input: Step,
        private readonly entitySegmentPath: string[],
        private readonly eventArrayName: string,
        private readonly orderBy: string[],
        private readonly properties: string[],
        private readonly outputProperties: string[],
        inputDescriptor: TypeDescriptor
    ) {
        this.eventSegmentPath = [...entitySegmentPath, eventArrayName];
        validateReplaceToDeltaConfiguration(
            inputDescriptor,
            this.entitySegmentPath,
            this.eventArrayName,
            this.orderBy,
            this.properties,
            this.outputProperties
        );

        this.propertyToOutput = new Map();
        this.properties.forEach((property, index) => {
            this.propertyToOutput.set(property, this.outputProperties[index]);
        });
        this.outputPropertiesSet = new Set(this.outputProperties);
        this.orderBySet = new Set(this.orderBy);

        this.input.onAdded(this.eventSegmentPath, (parentKey, key, immutableProps) => {
            if (parentKey !== undefined) {
                this.handleEventAdded(parentKey, key, immutableProps);
            }
        });
        this.input.onRemoved(this.eventSegmentPath, (key, immutableProps) => {
            this.handleEventRemoved(key, immutableProps);
        });
        this.input.onPlaced(this.eventSegmentPath, (key, _oldParentKey, newParentKey) => {
            this.handleEventPlaced(key, newParentKey);
        });
        for (const property of new Set([...this.properties, ...this.orderBy])) {
            this.input.onModified(this.eventSegmentPath, property, (key, oldValue, newValue) => {
                this.handleTrackedPropertyModified(key, property, oldValue, newValue);
            });
        }
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

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        if (pathsMatch(pathSegments, this.eventSegmentPath)) {
            this.placedHandlers.push(handler);
            return;
        }
        this.input.onPlaced(pathSegments, handler);
    }

    private neighbors(entity: EntityState, eventIndex: number): [EventRecord | undefined, string | undefined] {
        const predecessor = eventIndex > 0
            ? this.events.get(entity.sortedEventKeys[eventIndex - 1])
            : undefined;
        const successorKey = eventIndex < entity.sortedEventKeys.length - 1
            ? entity.sortedEventKeys[eventIndex + 1]
            : undefined;
        return [predecessor, successorKey];
    }

    /** Inserts an event into its entity's order and updates its successor's deltas. */
    private attach(eventKey: string, record: EventRecord): Record<string, number> {
        let entity = this.entities.get(record.parentKey);
        if (!entity) {
            entity = { sortedEventKeys: [] };
            this.entities.set(record.parentKey, entity);
        }
        const insertIndex = this.insertEventKey(entity, eventKey);
        const [predecessor, successorKey] = this.neighbors(entity, insertIndex);
        if (successorKey) {
            this.emitSuccessorDeltaChanges(successorKey, predecessor, record);
        }
        return this.computeAllDeltas(record, predecessor);
    }

    /** Removes an event from its entity's order and updates its successor's deltas. */
    private detach(eventKey: string, record: EventRecord): Record<string, number> {
        const entity = this.entities.get(record.parentKey);
        const eventIndex = entity ? entity.sortedEventKeys.indexOf(eventKey) : -1;
        if (!entity || eventIndex < 0) {
            return this.computeAllDeltas(record, undefined);
        }
        const [predecessor, successorKey] = this.neighbors(entity, eventIndex);
        if (successorKey) {
            this.emitSuccessorDeltaChanges(successorKey, record, predecessor);
        }
        entity.sortedEventKeys.splice(eventIndex, 1);
        if (entity.sortedEventKeys.length === 0) {
            this.entities.delete(record.parentKey);
        }
        return this.computeAllDeltas(record, predecessor);
    }

    private handleEventAdded(parentKey: string, eventKey: string, immutableProps: ImmutableProps): void {
        const existingRecord = this.events.get(eventKey);
        if (existingRecord) {
            this.handleEventRemoved(eventKey, existingRecord.immutableProps);
        }

        const record: EventRecord = { parentKey, immutableProps, mutableValues: new Map() };
        this.events.set(eventKey, record);
        const deltas = this.attach(eventKey, record);
        const augmentedProps: ImmutableProps = { ...immutableProps, ...deltas };
        this.addedHandlers.forEach(handler => handler(parentKey, eventKey, augmentedProps));
    }

    private handleEventRemoved(eventKey: string, immutableProps: ImmutableProps): void {
        const record = this.events.get(eventKey);
        if (!record) {
            const fallbackDeltas = this.computeAllDeltas({ parentKey: '', immutableProps, mutableValues: new Map() }, undefined);
            this.emitRemoved(eventKey, immutableProps, fallbackDeltas);
            return;
        }
        const deltas = this.detach(eventKey, record);
        this.events.delete(eventKey);
        this.emitRemoved(eventKey, record.immutableProps, deltas);
    }

    /** Moves an event to another entity: its deltas are recomputed against its new predecessor. */
    private handleEventPlaced(eventKey: string, newParentKey: string): void {
        const record = this.events.get(eventKey);
        if (!record) {
            return;
        }
        const oldParentKey = record.parentKey;
        const oldDeltas = this.detach(eventKey, record);
        record.parentKey = newParentKey;
        this.placedHandlers.forEach(handler => handler(eventKey, oldParentKey, newParentKey));
        const newDeltas = this.attach(eventKey, record);
        for (const outputProperty of this.outputProperties) {
            if (!Object.is(oldDeltas[outputProperty], newDeltas[outputProperty])) {
                this.emitModified(eventKey, outputProperty, oldDeltas[outputProperty], newDeltas[outputProperty]);
            }
        }
    }

    private handleTrackedPropertyModified(
        eventKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        if (this.orderBySet.has(propertyName)) {
            this.handleOrderByPropertyModified(eventKey, propertyName, newValue);
            return;
        }
        this.handleValuePropertyModified(eventKey, propertyName, oldValue, newValue);
    }

    private handleValuePropertyModified(
        eventKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        const outputProperty = this.propertyToOutput.get(propertyName);
        if (!outputProperty) {
            return;
        }
        const record = this.events.get(eventKey);
        if (!record) {
            return;
        }
        const entity = this.entities.get(record.parentKey);
        if (!entity) {
            return;
        }
        const eventIndex = entity.sortedEventKeys.indexOf(eventKey);
        if (eventIndex < 0) {
            return;
        }

        const [predecessor, successorKey] = this.neighbors(entity, eventIndex);

        const predecessorValue = predecessor
            ? this.getNumericPropertyValue(predecessor, propertyName)
            : 0;
        const oldDelta = finiteNumericValue(oldValue) - predecessorValue;
        const newDelta = finiteNumericValue(newValue) - predecessorValue;

        record.mutableValues.set(propertyName, newValue);

        if (!Object.is(oldDelta, newDelta)) {
            this.emitModified(eventKey, outputProperty, oldDelta, newDelta);
        }

        if (successorKey) {
            const successor = this.events.get(successorKey);
            if (!successor) {
                return;
            }
            const successorValue = this.getNumericPropertyValue(successor, propertyName);
            const oldSuccessorDelta = successorValue - finiteNumericValue(oldValue);
            const newSuccessorDelta = successorValue - finiteNumericValue(newValue);
            if (!Object.is(oldSuccessorDelta, newSuccessorDelta)) {
                this.emitModified(successorKey, outputProperty, oldSuccessorDelta, newSuccessorDelta);
            }
        }
    }

    private handleOrderByPropertyModified(eventKey: string, propertyName: string, newValue: unknown): void {
        const record = this.events.get(eventKey);
        if (!record) {
            return;
        }
        const entity = this.entities.get(record.parentKey);
        if (!entity) {
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
        this.emitDeltaSnapshotChanges(previousSnapshot, nextSnapshot);
    }

    private emitSuccessorDeltaChanges(
        successorKey: string,
        oldPredecessor: EventRecord | undefined,
        newPredecessor: EventRecord | undefined
    ): void {
        const successorRecord = this.events.get(successorKey);
        if (!successorRecord) {
            return;
        }

        this.properties.forEach((propertyName, index) => {
            const outputProperty = this.outputProperties[index];
            const oldDelta = this.computeDeltaForProperty(successorRecord, oldPredecessor, propertyName);
            const newDelta = this.computeDeltaForProperty(successorRecord, newPredecessor, propertyName);
            if (!Object.is(oldDelta, newDelta)) {
                this.emitModified(successorKey, outputProperty, oldDelta, newDelta);
            }
        });
    }

    private emitRemoved(eventKey: string, immutableProps: ImmutableProps, deltas: Record<string, number>): void {
        const augmentedProps: ImmutableProps = { ...immutableProps, ...deltas };
        this.removedHandlers.forEach(handler => handler(eventKey, augmentedProps));
    }

    private emitModified(eventKey: string, outputProperty: string, oldValue: number, newValue: number): void {
        const handlers = this.modifiedHandlersByProperty.get(outputProperty) ?? [];
        handlers.forEach(handler => handler(eventKey, oldValue, newValue));
    }

    private snapshotEntityDeltas(entity: EntityState): Map<string, Record<string, number>> {
        const snapshot = new Map<string, Record<string, number>>();
        let predecessor: EventRecord | undefined;
        for (const key of entity.sortedEventKeys) {
            const record = this.events.get(key);
            if (!record) {
                continue;
            }
            snapshot.set(key, this.computeAllDeltas(record, predecessor));
            predecessor = record;
        }
        return snapshot;
    }

    private emitDeltaSnapshotChanges(
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
                    this.emitModified(key, outputProperty, oldValue, newValue);
                }
            }
        }
    }

    private insertEventKey(entity: EntityState, eventKey: string): number {
        const sortedEventKeys = entity.sortedEventKeys;
        let low = 0;
        let high = sortedEventKeys.length;

        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            const comparison = this.compareEvents(eventKey, sortedEventKeys[mid]);
            if (comparison < 0) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        sortedEventKeys.splice(low, 0, eventKey);
        return low;
    }

    private compareEvents(leftKey: string, rightKey: string): number {
        const leftRecord = this.events.get(leftKey);
        const rightRecord = this.events.get(rightKey);
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
        const inputDescriptor = this.upstream.getTypeDescriptor();
        validateReplaceToDeltaConfiguration(
            inputDescriptor,
            this.entitySegmentPath,
            this.eventArrayName,
            this.orderBy,
            this.properties,
            this.outputProperties
        );
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

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new ReplaceToDeltaStep(
                up.lastStep,
                this.entitySegmentPath,
                this.eventArrayName,
                this.orderBy,
                this.properties,
                this.outputProperties,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
