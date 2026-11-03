import type {
    AddedHandler,
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
import { appendMutableIfMissing, appendObjectIfMissing } from '../util/descriptor-transform.js';
import { pathsMatch } from '../util/path.js';
import { collectAllMutableProperties, getPathSegmentsFromDescriptor as getAllPathSegmentsFromDescriptor } from '../pipeline.js';
import { PlacementIndex, addNode, modifyNode, moveNode, removeNode, type KeyedTree } from '../util/keyed-tree.js';

function stableSerialize(value: unknown): string {
    return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
    try {
        return stableSerialize(left) === stableSerialize(right);
    } catch {
        // If either value cannot be serialized (e.g., circular reference, BigInt),
        // treat them as unequal rather than crashing the pipeline.
        return false;
    }
}

type EmitDiagnostic = (diagnostic: {
    code:
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
}) => void;

interface PrimaryRecord {
    immutableProps: ImmutableProps;
    /** Serialized join tuple when indexed; null when the row has no valid join (same as add skipped). */
    joinKeyHash: string | null;
}


function addObjectAtPath(
    descriptor: DescriptorNode,
    path: string[],
    objectDesc: { name: string; type: DescriptorNode }
): DescriptorNode {
    if (path.length === 0) {
        return appendObjectIfMissing(descriptor, objectDesc);
    }

    const [first, ...rest] = path;
    return {
        ...descriptor,
        arrays: descriptor.arrays.map(arr => {
            if (arr.name !== first) {
                return arr;
            }
            return {
                ...arr,
                type: addObjectAtPath(arr.type, rest, objectDesc)
            };
        })
    };
}

function transformEnrichDescriptor(
    inputDescriptor: TypeDescriptor,
    secondaryDescriptor: TypeDescriptor,
    scopeSegments: string[],
    asProperty: string
): TypeDescriptor {
    const secondaryRoot: DescriptorNode = {
        arrays: secondaryDescriptor.arrays,
        collectionKey: secondaryDescriptor.collectionKey,
        scalars: secondaryDescriptor.scalars,
        objects: secondaryDescriptor.objects,
        mutableProperties: secondaryDescriptor.mutableProperties
    };

    if (scopeSegments.length === 0) {
        const withObject = appendObjectIfMissing(inputDescriptor, {
            name: asProperty,
            type: secondaryRoot
        });
        return appendMutableIfMissing(withObject, asProperty) as TypeDescriptor;
    }

    const atScope = addObjectAtPath(inputDescriptor, scopeSegments, {
        name: asProperty,
        type: secondaryRoot
    });
    return {
        ...appendMutableIfMissing(atScope, asProperty),
        rootCollectionName: inputDescriptor.rootCollectionName
    };
}

export class EnrichBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        readonly sourceName: string,
        readonly secondaryLastBuilder: StepBuilder,
        readonly scopeSegments: string[],
        readonly primaryKey: string[],
        readonly asProperty: string,
        readonly whenMissing: ImmutableProps | undefined
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformEnrichDescriptor(
            this.upstream.getTypeDescriptor(),
            this.secondaryLastBuilder.getTypeDescriptor(),
            this.scopeSegments,
            this.asProperty
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const primary = this.upstream.buildGraph(ctx);
        const secondary = this.secondaryLastBuilder.buildGraph(ctx);
        const secondaryDescriptor = this.secondaryLastBuilder.getTypeDescriptor();
        secondary.rootInput.setSources(secondary.sources);
        const mergedSources = {
            ...primary.sources,
            [this.sourceName]: secondary.rootInput
        };
        return {
            rootInput: primary.rootInput,
            sources: mergedSources,
            lastStep: new EnrichStep(
                primary.lastStep,
                secondary.lastStep,
                this.scopeSegments,
                this.primaryKey,
                this.asProperty,
                this.whenMissing,
                secondaryDescriptor,
                ctx.emitDiagnostic
            )
        };
    }
}

export class EnrichStep implements Step {
    private readonly primaryRowsById = new Map<string, PrimaryRecord>();
    private readonly primaryIdsByJoinKey = new Map<string, Set<string>>();
    private readonly secondaryRowByJoinKey = new Map<string, ImmutableProps>();
    private readonly modifiedHandlers: ModifiedHandler[] = [];
    /** The secondary pipeline's output, and the placement of each of its nested nodes. */
    private secondaryState: KeyedTree = [];
    private readonly secondaryPlacements = new PlacementIndex();
    private readonly secondaryCollectionKey: string[];

    constructor(
        private readonly input: Step,
        private readonly secondary: Step,
        private readonly scopeSegments: string[],
        private readonly primaryKey: string[],
        private readonly asProperty: string,
        private readonly whenMissing: ImmutableProps | undefined,
        secondaryDescriptor: TypeDescriptor,
        private readonly emitDiagnostic?: EmitDiagnostic
    ) {
        this.input.onAdded(this.scopeSegments, (_parentKey, key, immutableProps) => {
            this.handlePrimaryAdded(key, immutableProps);
        });
        this.input.onRemoved(this.scopeSegments, key => {
            this.handlePrimaryRemoved(key);
        });

        const primaryKeyColumns = new Set(this.primaryKey);
        for (const propertyName of primaryKeyColumns) {
            this.input.onModified(this.scopeSegments, propertyName, (key, _oldValue, newValue) => {
                this.handlePrimaryJoinKeyPropertyModified(key, propertyName, newValue);
            });
        }

        this.secondaryCollectionKey = secondaryDescriptor.collectionKey;
        const secondaryPaths = getAllPathSegmentsFromDescriptor(secondaryDescriptor);
        const mutableProperties = collectAllMutableProperties(secondaryDescriptor);

        for (const segmentPath of secondaryPaths) {
            this.secondary.onAdded(segmentPath, (parentKey, key, immutableProps) => {
                this.handleSecondaryAdded(segmentPath, parentKey, key, immutableProps);
            });
            this.secondary.onRemoved(segmentPath, key => {
                this.handleSecondaryRemoved(segmentPath, key);
            });
            this.secondary.onPlaced(segmentPath, (key, _oldParentKey, newParentKey) => {
                this.handleSecondaryPlaced(segmentPath, key, newParentKey);
            });
            for (const propertyName of mutableProperties) {
                this.secondary.onModified(segmentPath, propertyName, (key, _oldValue, newValue) => {
                    this.handleSecondaryModified(segmentPath, key, propertyName, newValue);
                });
            }
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments)) {
            this.input.onAdded(pathSegments, (parentKey, key, immutableProps) => {
                const enrichedValue = this.resolveEnrichmentForPrimary(immutableProps);
                handler(parentKey, key, {
                    ...immutableProps,
                    [this.asProperty]: enrichedValue
                });
            });
            return;
        }
        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments)) {
            this.input.onRemoved(pathSegments, (key, immutableProps) => {
                const enrichedValue = this.resolveEnrichmentForPrimary(immutableProps);
                handler(key, {
                    ...immutableProps,
                    [this.asProperty]: enrichedValue
                });
            });
            return;
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.scopeSegments) && propertyName === this.asProperty) {
            this.modifiedHandlers.push(handler);
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        this.input.onPlaced(pathSegments, handler);
    }

    private secondaryJoinFromSecondaryRow(row: ImmutableProps): string | null {
        const secondaryCollectionKey = this.secondaryCollectionKey;
        if (secondaryCollectionKey.length === 0) {
            this.emitDiagnostic?.({
                code: 'enrich_secondary_collection_key_missing',
                message: 'Secondary descriptor has no collectionKey; enrichment cannot match rows.'
            });
            return null;
        }
        if (secondaryCollectionKey.length !== this.primaryKey.length) {
            this.emitDiagnostic?.({
                code: 'enrich_key_arity_mismatch',
                message: 'Primary key count does not match secondary collection key count.'
            });
            return null;
        }
        const tuple = secondaryCollectionKey.map(name => row[name]);
        return stableSerialize(tuple);
    }

    private primaryJoinFromPrimaryRow(row: ImmutableProps): string | null {
        const secondaryCollectionKey = this.secondaryCollectionKey;
        if (secondaryCollectionKey.length !== this.primaryKey.length) {
            this.emitDiagnostic?.({
                code: 'enrich_key_arity_mismatch',
                message: 'Primary key count does not match secondary collection key count.'
            });
            return null;
        }
        for (const property of this.primaryKey) {
            if (!(property in row)) {
                this.emitDiagnostic?.({
                    code: 'enrich_invalid_primary_key_property',
                    message: `Primary row does not contain key property "${property}".`
                });
                return null;
            }
        }
        const tuple = this.primaryKey.map(name => row[name]);
        return stableSerialize(tuple);
    }

    private resolveEnrichmentFromJoinHash(joinHash: string | null): ImmutableProps | undefined {
        if (joinHash === null) {
            return this.whenMissing;
        }
        return this.secondaryRowByJoinKey.get(joinHash) ?? this.whenMissing;
    }

    private resolveEnrichmentForPrimary(primaryRow: ImmutableProps): ImmutableProps | undefined {
        const joinHash = this.primaryJoinFromPrimaryRow(primaryRow);
        return this.resolveEnrichmentFromJoinHash(joinHash);
    }

    private handlePrimaryAdded(key: string, immutableProps: ImmutableProps): void {
        const joinHash = this.primaryJoinFromPrimaryRow(immutableProps);
        if (joinHash === null) {
            return;
        }
        this.primaryRowsById.set(key, {
            immutableProps,
            joinKeyHash: joinHash
        });
        let ids = this.primaryIdsByJoinKey.get(joinHash);
        if (!ids) {
            ids = new Set<string>();
            this.primaryIdsByJoinKey.set(joinHash, ids);
        }
        ids.add(key);
    }

    private handlePrimaryRemoved(key: string): void {
        const existing = this.primaryRowsById.get(key);
        if (!existing) {
            return;
        }
        this.primaryRowsById.delete(key);
        if (existing.joinKeyHash === null) {
            return;
        }
        const ids = this.primaryIdsByJoinKey.get(existing.joinKeyHash);
        if (!ids) {
            return;
        }
        ids.delete(key);
        if (ids.size === 0) {
            this.primaryIdsByJoinKey.delete(existing.joinKeyHash);
        }
    }

    private handlePrimaryJoinKeyPropertyModified(key: string, propertyName: string, newValue: unknown): void {
        const record = this.primaryRowsById.get(key);
        if (!record) {
            return;
        }

        const mergedRow = { ...record.immutableProps, [propertyName]: newValue };
        const newJoinHash = this.primaryJoinFromPrimaryRow(mergedRow);
        const oldJoinHash = record.joinKeyHash;

        record.immutableProps = mergedRow;

        if (oldJoinHash === newJoinHash) {
            return;
        }

        const oldEnrichment = this.resolveEnrichmentFromJoinHash(oldJoinHash);
        const newEnrichment = this.resolveEnrichmentFromJoinHash(newJoinHash);

        if (oldJoinHash !== null) {
            const oldSet = this.primaryIdsByJoinKey.get(oldJoinHash);
            if (oldSet) {
                oldSet.delete(key);
                if (oldSet.size === 0) {
                    this.primaryIdsByJoinKey.delete(oldJoinHash);
                }
            }
        }

        record.joinKeyHash = newJoinHash;
        if (newJoinHash !== null) {
            let ids = this.primaryIdsByJoinKey.get(newJoinHash);
            if (!ids) {
                ids = new Set<string>();
                this.primaryIdsByJoinKey.set(newJoinHash, ids);
            }
            ids.add(key);
        }

        const previous = oldEnrichment ?? this.whenMissing;
        const next = newEnrichment ?? this.whenMissing;
        if (valuesEqual(previous, next)) {
            return;
        }
        this.modifiedHandlers.forEach(handler => {
            handler(key, previous, next);
        });
    }

    /** Key of the root row of the secondary output that contains a node. */
    private secondaryRootKey(segmentPath: string[], key: string): string | undefined {
        if (segmentPath.length === 0) {
            return key;
        }
        return this.secondaryPlacements.locateNode(segmentPath, key)?.[0];
    }

    /** Applies a change to the secondary output and propagates changes to affected root rows. */
    private updateSecondary(rootKeys: (string | undefined)[], change: (state: KeyedTree) => KeyedTree | undefined): void {
        const roots = [...new Set(rootKeys.filter((rootKey): rootKey is string => rootKey !== undefined))];
        const oldRows = roots.map(rootKey => getRowByKey(this.secondaryState, rootKey));
        const next = change(this.secondaryState);
        if (next === undefined) {
            return;
        }
        this.secondaryState = next;
        roots.forEach((rootKey, index) => {
            this.applySecondaryRootChange(oldRows[index], getRowByKey(this.secondaryState, rootKey));
        });
    }

    private handleSecondaryAdded(segmentPath: string[], parentKey: string | undefined, key: string, immutableProps: ImmutableProps): void {
        const keyPath = this.secondaryPlacements.locate(segmentPath, parentKey);
        if (keyPath === undefined) {
            return;
        }
        this.secondaryPlacements.set(segmentPath, key, parentKey);
        const rootKey = segmentPath.length === 0 ? key : keyPath[0];
        this.updateSecondary([rootKey], state => addNode(state, segmentPath, keyPath, key, immutableProps));
    }

    private handleSecondaryRemoved(segmentPath: string[], key: string): void {
        const keyPath = this.secondaryPlacements.locateNode(segmentPath, key);
        if (keyPath === undefined) {
            return;
        }
        const rootKey = this.secondaryRootKey(segmentPath, key);
        this.secondaryPlacements.delete(segmentPath, key);
        this.updateSecondary([rootKey], state => removeNode(state, segmentPath, keyPath, key));
    }

    private handleSecondaryPlaced(segmentPath: string[], key: string, newParentKey: string): void {
        const keyPath = this.secondaryPlacements.locateNode(segmentPath, key);
        const toKeyPath = this.secondaryPlacements.locate(segmentPath, newParentKey);
        if (keyPath === undefined || toKeyPath === undefined) {
            return;
        }
        this.secondaryPlacements.set(segmentPath, key, newParentKey);
        this.updateSecondary([keyPath[0], toKeyPath[0]], state => moveNode(state, segmentPath, keyPath, toKeyPath, key));
    }

    private handleSecondaryModified(segmentPath: string[], key: string, propertyName: string, newValue: unknown): void {
        const keyPath = this.secondaryPlacements.locateNode(segmentPath, key);
        if (keyPath === undefined) {
            return;
        }
        const rootKey = this.secondaryRootKey(segmentPath, key);
        this.updateSecondary([rootKey], state => modifyNode(state, segmentPath, keyPath, key, propertyName, newValue));
    }

    private applySecondaryRootChange(
        oldRootRow: ImmutableProps | undefined,
        newRootRow: ImmutableProps | undefined
    ): void {
        const oldJoinHash = oldRootRow ? this.secondaryJoinFromSecondaryRow(oldRootRow) : null;
        const newJoinHash = newRootRow ? this.secondaryJoinFromSecondaryRow(newRootRow) : null;

        if (oldJoinHash !== null && oldJoinHash !== newJoinHash) {
            this.secondaryRowByJoinKey.delete(oldJoinHash);
            this.emitModifiedForJoinKey(oldJoinHash, oldRootRow, this.whenMissing);
        }

        if (newJoinHash !== null && newRootRow) {
            this.secondaryRowByJoinKey.set(newJoinHash, newRootRow);
            if (oldJoinHash === newJoinHash) {
                this.emitModifiedForJoinKey(newJoinHash, oldRootRow, newRootRow);
            }
            else {
                this.emitModifiedForJoinKey(newJoinHash, this.whenMissing, newRootRow);
            }
            return;
        }

        if (oldJoinHash !== null && oldJoinHash === newJoinHash) {
            this.secondaryRowByJoinKey.delete(oldJoinHash);
            this.emitModifiedForJoinKey(oldJoinHash, oldRootRow, this.whenMissing);
        }
    }

    private emitModifiedForJoinKey(
        joinHash: string,
        oldValue: ImmutableProps | undefined,
        newValue: ImmutableProps | undefined
    ): void {
        const previous = oldValue ?? this.whenMissing;
        const next = newValue ?? this.whenMissing;

        if (valuesEqual(previous, next)) {
            return;
        }
        const impactedPrimaryIds = this.primaryIdsByJoinKey.get(joinHash);
        if (!impactedPrimaryIds || impactedPrimaryIds.size === 0) {
            return;
        }
        for (const id of impactedPrimaryIds) {
            this.modifiedHandlers.forEach(handler => {
                handler(id, previous, next);
            });
        }
    }
}

function getRowByKey(state: KeyedTree, key: string): ImmutableProps | undefined {
    return state.find(item => item.key === key)?.value as ImmutableProps | undefined;
}
