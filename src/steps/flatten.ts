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
    ScalarDescriptor,
    StepBuilder,
    Step,
    TypeDescriptor
} from '../pipeline.js';
import { pathsMatch, pathStartsWith } from '../util/path.js';
import { getMutablePropertiesOfArrayItems } from '../pipeline.js';

function mergeScalarsWithChildPrecedence(
    parentScalars: ScalarDescriptor[],
    childScalars: ScalarDescriptor[]
): ScalarDescriptor[] {
    const scalarMap = new Map<string, ScalarDescriptor>();
    parentScalars.forEach(scalar => scalarMap.set(scalar.name, scalar));
    childScalars.forEach(scalar => scalarMap.set(scalar.name, scalar));
    return Array.from(scalarMap.values());
}

function mergeObjectsWithChildPrecedence(
    parentObjects: DescriptorNode['objects'],
    childObjects: DescriptorNode['objects']
): DescriptorNode['objects'] {
    const objectMap = new Map<string, DescriptorNode['objects'][number]>();
    parentObjects.forEach(objectDescriptor => objectMap.set(objectDescriptor.name, objectDescriptor));
    childObjects.forEach(objectDescriptor => objectMap.set(objectDescriptor.name, objectDescriptor));
    return Array.from(objectMap.values());
}

/**
 * The properties of a flattened item that can change: its child's, and the parent values it
 * inherits (those its child does not shadow), which change when the parent's do. When the
 * child can move to another parent, every inherited value can change.
 *
 * As in `FlattenStep.isShadowed`, only a child's declared scalars shadow a parent value. A
 * child may declare an object it has no value for, so objects do not.
 */
function flattenedMutableProperties(parentArray: ArrayDescriptor, childArray: ArrayDescriptor): string[] {
    const shadowed = new Set(childArray.type.scalars.map(scalar => scalar.name));
    const inherited = childArray.mutablePlacement
        ? [
            ...parentArray.type.scalars.map(scalar => scalar.name),
            ...parentArray.type.objects.map(objectDescriptor => objectDescriptor.name)
        ]
        : parentArray.type.mutableProperties;
    return [...new Set([
        ...childArray.type.mutableProperties,
        ...inherited.filter(name => !shadowed.has(name))
    ])];
}

function navigateToScopeNode(node: DescriptorNode, remainingSegments: string[]): DescriptorNode | null {
    if (remainingSegments.length === 0) {
        return node;
    }

    const [segment, ...rest] = remainingSegments;
    const arrayDescriptor = node.arrays.find(array => array.name === segment);
    if (!arrayDescriptor) {
        return null;
    }
    return navigateToScopeNode(arrayDescriptor.type, rest);
}

function assertValidFlattenConfiguration(
    descriptor: TypeDescriptor,
    scopePath: string[],
    parentArrayName: string,
    childArrayName: string,
    outputArrayName: string
): void {
    const scopeNode = navigateToScopeNode(descriptor, [...scopePath]);
    if (scopeNode === null) {
        throw new Error(`flatten scope path is invalid: [${scopePath.join('.')}]`);
    }

    const parentArray = scopeNode.arrays.find(arrayDescriptor => arrayDescriptor.name === parentArrayName);
    if (!parentArray) {
        throw new Error(`flatten parent array not found at current scope: "${parentArrayName}"`);
    }

    const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === childArrayName);
    if (!childArray) {
        throw new Error(`flatten child array not found within parent array "${parentArrayName}": "${childArrayName}"`);
    }

    if (scopeNode.arrays.some(arrayDescriptor => arrayDescriptor.name === outputArrayName)) {
        throw new Error(`flatten output array already exists at current scope: "${outputArrayName}"`);
    }

    // A flattened row would show only the child's value of a name both declare. Reject it, so
    // that each name in a flattened row means one thing. The types reject every such name; this
    // check sees only the names the descriptors declare.
    const childNames = new Set([
        ...childArray.type.scalars.map(scalar => scalar.name),
        ...childArray.type.objects.map(objectDescriptor => objectDescriptor.name),
        ...childArray.type.arrays.map(arrayDescriptor => arrayDescriptor.name)
    ]);
    const collisions = [
        ...parentArray.type.scalars.map(scalar => scalar.name),
        ...parentArray.type.objects.map(objectDescriptor => objectDescriptor.name)
    ].filter(name => childNames.has(name));
    if (collisions.length > 0) {
        throw new Error(
            `flatten would hide the parent's ${collisions.map(name => `"${name}"`).join(', ')} behind the child's ` +
            `property of the same name: rename one of them before flattening`
        );
    }
}

function getChildScalarNamesFromDescriptor(
    descriptor: TypeDescriptor,
    scopePath: string[],
    parentArrayName: string,
    childArrayName: string
): Set<string> {
    const scopeNode = navigateToScopeNode(descriptor, [...scopePath]);
    if (!scopeNode) {
        return new Set<string>();
    }

    const parentArray = scopeNode.arrays.find(arrayDescriptor => arrayDescriptor.name === parentArrayName);
    if (!parentArray) {
        return new Set<string>();
    }

    const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === childArrayName);
    if (!childArray) {
        return new Set<string>();
    }

    return new Set(childArray.type.scalars.map(scalar => scalar.name));
}

function transformDescriptorAtScope(
    node: DescriptorNode,
    remainingScopePath: string[],
    parentArrayName: string,
    childArrayName: string,
    outputArrayName: string
): DescriptorNode {
    if (remainingScopePath.length === 0) {
        const parentArray = node.arrays.find(arrayDescriptor => arrayDescriptor.name === parentArrayName);
        if (!parentArray) {
            return node;
        }
        const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === childArrayName);
        if (!childArray) {
            return node;
        }

        const mergedScalars = mergeScalarsWithChildPrecedence(parentArray.type.scalars, childArray.type.scalars);
        const flattenedNode: DescriptorNode = {
            arrays: childArray.type.arrays,
            collectionKey: [...parentArray.type.collectionKey, ...childArray.type.collectionKey],
            scalars: mergedScalars,
            objects: mergeObjectsWithChildPrecedence(parentArray.type.objects, childArray.type.objects),
            mutableProperties: flattenedMutableProperties(parentArray, childArray)
        };

        // A flattened item moves when its parent moves (with the parent's other children)
        // or when it moves to another parent.
        const arrays = node.arrays.map(arrayDescriptor => {
            if (arrayDescriptor.name === parentArrayName) {
                return {
                    name: outputArrayName,
                    type: flattenedNode,
                    mutablePlacement: parentArray.mutablePlacement || childArray.mutablePlacement
                };
            }
            return arrayDescriptor;
        });

        return {
            ...node,
            arrays
        };
    }

    const [segment, ...rest] = remainingScopePath;
    return {
        ...node,
        arrays: node.arrays.map(arrayDescriptor => {
            if (arrayDescriptor.name !== segment) {
                return arrayDescriptor;
            }
            return {
                ...arrayDescriptor,
                type: transformDescriptorAtScope(
                    arrayDescriptor.type,
                    rest,
                    parentArrayName,
                    childArrayName,
                    outputArrayName
                )
            };
        })
    };
}

function transformFlattenDescriptor(
    inputDescriptor: TypeDescriptor,
    parentPath: string[],
    childPath: string[],
    outputPath: string[]
): TypeDescriptor {
    const scopePath = outputPath.slice(0, -1);
    const parentArrayName = parentPath[parentPath.length - 1];
    const childArrayName = childPath[childPath.length - 1];
    const outputArrayName = outputPath[outputPath.length - 1];
    assertValidFlattenConfiguration(inputDescriptor, scopePath, parentArrayName, childArrayName, outputArrayName);
    return {
        ...transformDescriptorAtScope(inputDescriptor, [...scopePath], parentArrayName, childArrayName, outputArrayName),
        rootCollectionName: inputDescriptor.rootCollectionName
    };
}

interface ParentRecord {
    /** Placement of the parent, which is also the placement of its flattened children. */
    parentKey: string;
    props: ImmutableProps;
    childKeys: Set<string>;
}

interface ChildRecord {
    parentKey: string;
    props: ImmutableProps;
}

/**
 * Replaces a parent array and its child array with one array of merged items, placed under
 * the parent's own parent. A flattened item keeps its child's key, which is unique within its
 * level, so the levels below it pass through unchanged. A parent and child may not share a
 * declared name (`assertValidFlattenConfiguration`); for a name only the payloads carry, the
 * child's value wins.
 */
export class FlattenStep implements Step {
    private readonly outputAddedHandlers: AddedHandler[] = [];
    private readonly outputRemovedHandlers: RemovedHandler[] = [];
    private readonly outputPlacedHandlers: PlacedHandler[] = [];
    private readonly outputModifiedHandlersByProperty: Map<string, ModifiedHandler[]> = new Map();

    private readonly parents: Map<string, ParentRecord> = new Map();
    private readonly childRecords: Map<string, ChildRecord> = new Map();

    private readonly scopePath: string[];
    private readonly parentArrayName: string;
    private readonly childArrayName: string;
    private readonly outputArrayName: string;
    private readonly childScalarNames: Set<string>;

    constructor(
        private input: Step,
        private parentPath: string[],
        private childPath: string[],
        private outputPath: string[],
        inputDescriptor: TypeDescriptor
    ) {
        if (this.parentPath.length === 0 || this.childPath.length === 0 || this.outputPath.length === 0) {
            throw new Error('flatten paths must be non-empty');
        }
        if (this.childPath.length !== this.parentPath.length + 1) {
            throw new Error('flatten child path must extend parent path by exactly one segment');
        }

        this.scopePath = this.outputPath.slice(0, -1);
        this.parentArrayName = this.parentPath[this.parentPath.length - 1];
        this.childArrayName = this.childPath[this.childPath.length - 1];
        this.outputArrayName = this.outputPath[this.outputPath.length - 1];
        this.childScalarNames = getChildScalarNamesFromDescriptor(
            inputDescriptor,
            this.scopePath,
            this.parentArrayName,
            this.childArrayName
        );
        assertValidFlattenConfiguration(
            inputDescriptor,
            this.scopePath,
            this.parentArrayName,
            this.childArrayName,
            this.outputArrayName
        );

        this.input.onAdded(this.parentPath, (parentKey, key, immutableProps) => {
            if (parentKey !== undefined) {
                this.parents.set(key, { parentKey, props: immutableProps, childKeys: new Set() });
            }
        });
        this.input.onRemoved(this.parentPath, key => {
            this.handleParentRemoved(key);
        });
        this.input.onPlaced(this.parentPath, (key, _oldParentKey, newParentKey) => {
            this.handleParentPlaced(key, newParentKey);
        });
        this.input.onAdded(this.childPath, (parentKey, key, immutableProps) => {
            if (parentKey !== undefined) {
                this.handleChildAdded(parentKey, key, immutableProps);
            }
        });
        this.input.onRemoved(this.childPath, key => {
            this.handleChildRemoved(key);
        });
        this.input.onPlaced(this.childPath, (key, _oldParentKey, newParentKey) => {
            this.handleChildPlaced(key, newParentKey);
        });

        for (const propertyName of getMutablePropertiesOfArrayItems(inputDescriptor, this.parentPath)) {
            this.input.onModified(this.parentPath, propertyName, (key, oldValue, newValue) => {
                this.handleParentModified(key, propertyName, oldValue, newValue);
            });
        }
        for (const propertyName of getMutablePropertiesOfArrayItems(inputDescriptor, this.childPath)) {
            this.input.onModified(this.childPath, propertyName, (key, oldValue, newValue) => {
                this.handleChildModified(key, propertyName, oldValue, newValue);
            });
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            this.outputAddedHandlers.push(handler);
            return;
        }
        this.input.onAdded(this.toInputPath(pathSegments), handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            this.outputRemovedHandlers.push(handler);
            return;
        }
        this.input.onRemoved(this.toInputPath(pathSegments), handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            const handlers = this.outputModifiedHandlersByProperty.get(propertyName) ?? [];
            handlers.push(handler);
            this.outputModifiedHandlersByProperty.set(propertyName, handlers);
            return;
        }
        this.input.onModified(this.toInputPath(pathSegments), propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            this.outputPlacedHandlers.push(handler);
            return;
        }
        this.input.onPlaced(this.toInputPath(pathSegments), handler);
    }

    /** Maps a path below the output array to the corresponding path below the child array. */
    private toInputPath(pathSegments: string[]): string[] {
        if (pathSegments.length > this.outputPath.length && pathStartsWith(pathSegments, this.outputPath)) {
            return [...this.childPath, ...pathSegments.slice(this.outputPath.length)];
        }
        return pathSegments;
    }

    private merge(parentProps: ImmutableProps, childProps: ImmutableProps): ImmutableProps {
        return { ...parentProps, ...childProps };
    }

    private emitModified(key: string, propertyName: string, oldValue: unknown, newValue: unknown): void {
        this.outputModifiedHandlersByProperty.get(propertyName)?.forEach(handler => handler(key, oldValue, newValue));
    }

    private handleChildAdded(parentKey: string, childKey: string, childProps: ImmutableProps): void {
        const parent = this.parents.get(parentKey);
        if (!parent) {
            return;
        }
        this.childRecords.set(childKey, { parentKey, props: childProps });
        parent.childKeys.add(childKey);
        const mergedProps = this.merge(parent.props, childProps);
        this.outputAddedHandlers.forEach(handler => handler(parent.parentKey, childKey, mergedProps));
    }

    /**
     * Flattened children live under the grandparent, so removing their parent does not
     * remove them from the output. Remove them here.
     */
    private handleParentRemoved(parentKey: string): void {
        const parent = this.parents.get(parentKey);
        if (!parent) {
            return;
        }
        for (const childKey of [...parent.childKeys]) {
            this.handleChildRemoved(childKey);
        }
        this.parents.delete(parentKey);
    }

    private handleChildRemoved(childKey: string): void {
        const child = this.childRecords.get(childKey);
        if (!child) {
            return;
        }
        const parent = this.parents.get(child.parentKey);
        parent?.childKeys.delete(childKey);
        this.childRecords.delete(childKey);
        const mergedProps = this.merge(parent?.props ?? {}, child.props);
        this.outputRemovedHandlers.forEach(handler => handler(childKey, mergedProps));
    }

    private handleChildModified(childKey: string, propertyName: string, oldValue: unknown, newValue: unknown): void {
        const child = this.childRecords.get(childKey);
        if (!child) {
            return;
        }
        child.props = { ...child.props, [propertyName]: newValue };
        this.emitModified(childKey, propertyName, oldValue, newValue);
    }

    /** A parent value reaches its flattened children unless the child has its own value of that name. */
    private isShadowed(child: ChildRecord, propertyName: string): boolean {
        return this.childScalarNames.has(propertyName) || Object.prototype.hasOwnProperty.call(child.props, propertyName);
    }

    private handleParentModified(parentKey: string, propertyName: string, oldValue: unknown, newValue: unknown): void {
        const parent = this.parents.get(parentKey);
        if (!parent) {
            return;
        }
        parent.props = { ...parent.props, [propertyName]: newValue };
        for (const childKey of parent.childKeys) {
            const child = this.childRecords.get(childKey);
            if (child && !this.isShadowed(child, propertyName)) {
                this.emitModified(childKey, propertyName, oldValue, newValue);
            }
        }
    }

    /** The parent's children move with it. */
    private handleParentPlaced(parentKey: string, newGrandparentKey: string): void {
        const parent = this.parents.get(parentKey);
        if (!parent) {
            return;
        }
        const oldGrandparentKey = parent.parentKey;
        parent.parentKey = newGrandparentKey;
        for (const childKey of parent.childKeys) {
            this.outputPlacedHandlers.forEach(handler => handler(childKey, oldGrandparentKey, newGrandparentKey));
        }
    }

    /**
     * A child that moves to another parent may move to another grandparent, and takes on the
     * new parent's values.
     */
    private handleChildPlaced(childKey: string, newParentKey: string): void {
        const child = this.childRecords.get(childKey);
        const oldParent = child ? this.parents.get(child.parentKey) : undefined;
        const newParent = this.parents.get(newParentKey);
        if (!child || !oldParent || !newParent) {
            return;
        }
        oldParent.childKeys.delete(childKey);
        newParent.childKeys.add(childKey);
        child.parentKey = newParentKey;
        if (oldParent.parentKey !== newParent.parentKey) {
            this.outputPlacedHandlers.forEach(handler => handler(childKey, oldParent.parentKey, newParent.parentKey));
        }
        const names = new Set([...Object.keys(oldParent.props), ...Object.keys(newParent.props)]);
        for (const propertyName of names) {
            const oldValue = oldParent.props[propertyName];
            const newValue = newParent.props[propertyName];
            if (!this.isShadowed(child, propertyName) && !Object.is(oldValue, newValue)) {
                this.emitModified(childKey, propertyName, oldValue, newValue);
            }
        }
    }
}

export class FlattenBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private parentPath: string[],
        private childPath: string[],
        private outputPath: string[]
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformFlattenDescriptor(this.upstream.getTypeDescriptor(), this.parentPath, this.childPath, this.outputPath);
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new FlattenStep(
                up.lastStep,
                this.parentPath,
                this.childPath,
                this.outputPath,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}
