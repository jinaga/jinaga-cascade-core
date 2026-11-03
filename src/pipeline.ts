type EmptySources = Record<never, never>;

export type PipelineSources<TSources extends Record<string, unknown>> = {
    [K in keyof TSources]:
        TSources[K] extends { primary: infer TSourcePrimary; sources?: infer TSourceChildren }
            ? PipelineInput<
                TSourcePrimary,
                TSourceChildren extends Record<string, unknown> ? TSourceChildren : EmptySources
            >
            : never;
};

type UntypedSourceGraphShape = {
    [sourceName: string]: {
        primary: unknown;
        sources?: UntypedSourceGraphShape;
    };
};

export type UntypedPipelineSources = PipelineSources<UntypedSourceGraphShape>;

export interface PipelineInput<T, TSources extends Record<string, unknown> = EmptySources> {
    add(key: string, immutableProps: T): void;
    remove(key: string, immutableProps: T): void;
    sources: PipelineSources<TSources>;
}

export interface SourceBindableInput<T, TSources extends Record<string, unknown> = EmptySources>
    extends PipelineInput<T, TSources> {
    setSources(sources: UntypedPipelineSources): void;
    /**
     * Emit an item add at a nested source path. `segmentPath` names the declared source
     * array (e.g. `['bookmarks']`); `parentKeyPath` is the runtime key path identifying the
     * parent item (length must equal `segmentPath.length`); `key` is the child's natural key.
     * Returns false, and emits nothing, when that parent is not present.
     */
    addAt(segmentPath: string[], parentKeyPath: string[], key: string, immutableProps: ImmutableProps): boolean;
    removeAt(segmentPath: string[], parentKeyPath: string[], key: string, immutableProps: ImmutableProps): void;
}

/**
 * Runtime handle for feeding children of a declared source-level array incrementally,
 * mirroring how Jinaga delivers nested projection collections. Obtain one from
 * {@link Pipeline.collection}.
 */
export interface CollectionInput {
    /**
     * Add a child item under a parent. `parentKeyPath` identifies the parent item: a single
     * key for a root-level array (e.g. `'F1'`), or a key path for deeper nesting
     * (e.g. `['F1', 'B1']`). `key` is the child's own natural key.
     */
    add(parentKeyPath: string | readonly string[], key: string, immutableProps: ImmutableProps): void;
    remove(parentKeyPath: string | readonly string[], key: string, immutableProps: ImmutableProps): void;
}

export interface PipelineRuntimeDiagnostic {
    code:
        | 'operation_after_dispose'
        | 'stale_epoch_operation_dropped'
        | 'missing_parent_add_dropped'
        | 'missing_parent_remove_dropped'
        | 'missing_parent_modify_dropped'
        | 'missing_item_modify_dropped'
        | 'enrich_key_arity_mismatch'
        | 'enrich_invalid_primary_key_property'
        | 'enrich_secondary_collection_key_missing';
    message: string;
    operationType?: 'add' | 'remove' | 'modify';
    segmentPath?: string[];
    keyPath?: string[];
    key?: string;
    parentKey?: string;
    epoch?: number;
}

export interface PipelineRuntimeOptions {
    batchSize?: number;
    flushDelayMs?: number;
    onDiagnostic?: (diagnostic: PipelineRuntimeDiagnostic) => void;
}

export interface PipelineRuntimeDisposeOptions {
    flush?: boolean;
}

export interface Pipeline<TStart, TSources extends Record<string, unknown> = EmptySources>
    extends PipelineInput<TStart, TSources> {
    /**
     * Obtain a handle for feeding children of a declared source-level array. Pass the segment
     * path to the array (e.g. `collection('bookmarks')`, or `collection('bookmarks', 'tags')`
     * for a nested array). At least one segment is required.
     */
    collection(firstSegment: string, ...restSegments: string[]): CollectionInput;
    flush(): void;
    dispose(options?: PipelineRuntimeDisposeOptions): void;
    isDisposed(): boolean;
}

export type ScalarType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface ScalarDescriptor {
    name: string;
    type: ScalarType;
}

export interface DescriptorNode {
    arrays: ArrayDescriptor[];
    collectionKey: string[];
    scalars: ScalarDescriptor[];
    /** Presentational object wiring; always an array (empty means none). */
    objects: ObjectDescriptor[];
    /** Property names that may change after add; always an array (empty means none). */
    mutableProperties: string[];
}

export interface TypeDescriptor extends DescriptorNode {
    rootCollectionName: string;
}

export interface ArrayDescriptor {
    name: string;
    type: DescriptorNode;
}

export interface ObjectDescriptor {
    name: string;
    type: DescriptorNode;
}

/**
 * Get the mutable properties of items within an array at the specified path.
 * Navigates through the TypeDescriptor following the segment path and returns
 * the mutableProperties of the final array's item type.
 *
 * @param descriptor - The root TypeDescriptor to start navigation from
 * @param segmentPath - Array of segment names to navigate (e.g., ['orders'] or ['categories', 'products'])
 * @returns Array of mutable property names, or empty array if path is invalid
 */
export function getMutablePropertiesOfArrayItems(
    descriptor: TypeDescriptor,
    segmentPath: string[]
): string[] {
    let current: DescriptorNode = descriptor;
    for (const segment of segmentPath) {
        const arrayDesc = current.arrays.find(a => a.name === segment);
        if (!arrayDesc) return [];
        current = arrayDesc.type;
    }
    return current.mutableProperties;
}

/**
 * Get the scalar descriptors at a specific path within the type descriptor.
 * Navigates through arrays following the segment path and returns scalars
 * at the final node.
 *
 * @param descriptor - The root TypeDescriptor to start navigation from
 * @param segmentPath - Array of segment names (e.g., [] for root, ['items'] for items array)
 * @returns Array of ScalarDescriptor at that path, or empty array if path is invalid
 */
export function getScalarsAtPath(
    descriptor: TypeDescriptor,
    segmentPath: string[]
): ScalarDescriptor[] {
    let current: DescriptorNode = descriptor;
    for (const segment of segmentPath) {
        const arrayDesc = current.arrays.find(a => a.name === segment);
        if (!arrayDesc) return [];
        current = arrayDesc.type;
    }
    return current.scalars;
}

/**
 * Names of the mutable properties at every level of a descriptor. Mutable properties are
 * recorded at the root of the descriptor even when they belong to nested levels.
 */
export function collectAllMutableProperties(descriptor: DescriptorNode): string[] {
    const names = new Set<string>(descriptor.mutableProperties);
    for (const array of descriptor.arrays) {
        collectAllMutableProperties(array.type).forEach(name => names.add(name));
    }
    return [...names];
}

export type ImmutableProps = {
    [key: string]: unknown;
};

/*
 * Event protocol.
 *
 * A node is identified by its level (segment path) and its key. Keys are unique within a
 * level across the whole pipeline, so a node's identity never depends on where it is placed.
 * A node's placement is the key of its parent at the level above. Placement is a changeable
 * value: it is set by `onAdded` and changed by `onPlaced`. Descendants keep their own
 * placement when an ancestor moves, so a move is a single event.
 *
 * `onAdded` carries the node's complete current values. `onModified` carries the old and new
 * value of one property. `onRemoved` carries the node's values at removal.
 */

/** `parentKey` is undefined for nodes at the root level. */
export type AddedHandler = (parentKey: string | undefined, key: string, immutableProps: ImmutableProps) => void;

export type RemovedHandler = (key: string, immutableProps: ImmutableProps) => void;

export type ModifiedHandler = (key: string, oldValue: unknown, newValue: unknown) => void;

/** A node at a nested level moved from one parent to another. */
export type PlacedHandler = (key: string, oldParentKey: string, newParentKey: string) => void;

export function getPathSegmentsFromDescriptor(descriptor: TypeDescriptor): string[][] {
    // Include the path to the root of the descriptor
    const paths: string[][] = [[]];
    // Recursively get paths from nested type descriptors
    for (const array of descriptor.arrays) {
        const allChildSegments = getPathSegmentsFromNode(array.type);
        for (const childSegments of allChildSegments) {
            paths.push([array.name, ...childSegments]);
        }
    }
    return paths;
}

function getPathSegmentsFromNode(descriptor: DescriptorNode): string[][] {
    const paths: string[][] = [[]];
    for (const array of descriptor.arrays) {
        const allChildSegments = getPathSegmentsFromNode(array.type);
        for (const childSegments of allChildSegments) {
            paths.push([array.name, ...childSegments]);
        }
    }
    return paths;
}

export interface Step {
    onAdded(pathSegments: string[], handler: AddedHandler): void;
    onRemoved(pathSegments: string[], handler: RemovedHandler): void;
    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void;
    onPlaced(pathSegments: string[], handler: PlacedHandler): void;
}

export interface BuiltStepGraph {
    rootInput: SourceBindableInput<unknown, Record<string, unknown>>;
    lastStep: Step;
    sources: UntypedPipelineSources;
}

export interface BuildContext {
    emitDiagnostic?: (diagnostic: {
        code:
            | 'enrich_key_arity_mismatch'
            | 'enrich_invalid_primary_key_property'
            | 'enrich_secondary_collection_key_missing';
        message: string;
    }) => void;
}

export interface StepBuilder {
    readonly upstream?: StepBuilder;
    getTypeDescriptor(): TypeDescriptor;
    buildGraph(ctx: BuildContext): BuiltStepGraph;
}

