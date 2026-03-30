import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    DescriptorNode,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    ScalarDescriptor,
    StepBuilder,
    Step,
    TypeDescriptor
} from '../pipeline.js';
import { computeHash } from '../util/hash.js';
import { pathsMatch, pathStartsWith } from '../util/path.js';
import { getDescriptorFromFactory } from '../step-builder-utils.js';

function parentIdentity(outputKeyPath: string[], parentKey: string): string {
    return JSON.stringify({ outputKeyPath, parentKey });
}

function compositeChildKey(parentKey: string, childKey: string): string {
    return computeHash(JSON.stringify([parentKey, childKey]));
}

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

function mergedMutableProperties(
    parentMutableProperties: string[],
    childMutableProperties: string[],
    mergedScalars: ScalarDescriptor[]
): string[] {
    const scalarNames = new Set(mergedScalars.map(s => s.name));
    const mutable = new Set<string>();
    for (const prop of parentMutableProperties) {
        if (scalarNames.has(prop)) {
            mutable.add(prop);
        }
    }
    for (const prop of childMutableProperties) {
        if (scalarNames.has(prop)) {
            mutable.add(prop);
        }
    }
    return Array.from(mutable);
}

export class FlattenStep implements Step {
    private readonly outputAddedHandlers: AddedHandler[] = [];
    private readonly outputRemovedHandlers: RemovedHandler[] = [];
    private readonly outputModifiedHandlersByProperty: Map<string, ModifiedHandler[]> = new Map();

    private readonly parentScalarsByParentIdentity: Map<string, ImmutableProps> = new Map();
    private readonly childKeysByParentIdentity: Map<string, Set<string>> = new Map();
    private readonly childPropertyCountsByParentIdentity: Map<string, Map<string, number>> = new Map();

    private readonly scopePath: string[];
    private readonly parentArrayName: string;
    private readonly childArrayName: string;
    private readonly outputArrayName: string;
    private readonly outputDepth: number;
    private readonly childScalarNames: Set<string>;

    constructor(
        private input: Step,
        private parentPath: string[],
        private childPath: string[],
        private outputPath: string[]
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
        this.outputDepth = this.outputPath.length;
        this.childScalarNames = this.getChildScalarNames(this.input.getTypeDescriptor());

        this.assertValidConfiguration(this.input.getTypeDescriptor());

        this.input.onAdded(this.parentPath, (keyPath, key, immutableProps) => {
            this.handleParentAdded(keyPath, key, immutableProps);
        });
        this.input.onRemoved(this.parentPath, (keyPath, key) => {
            this.handleParentRemoved(keyPath, key);
        });
        this.input.onAdded(this.childPath, (keyPath, key, immutableProps) => {
            this.handleChildAdded(keyPath, key, immutableProps);
        });
        this.input.onRemoved(this.childPath, (keyPath, key, immutableProps) => {
            this.handleChildRemoved(keyPath, key, immutableProps);
        });

        const mutableProperties = this.input.getTypeDescriptor().mutableProperties;
        for (const propertyName of mutableProperties) {
            this.input.onModified(this.parentPath, propertyName, (keyPath, key, oldValue, newValue) => {
                this.handleParentModified(keyPath, key, propertyName, oldValue, newValue);
            });
            this.input.onModified(this.childPath, propertyName, (keyPath, key, oldValue, newValue) => {
                this.handleChildModified(keyPath, key, propertyName, oldValue, newValue);
            });
        }
    }

    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        this.assertValidConfiguration(inputDescriptor);
        return {
            ...this.transformDescriptorAtScope(inputDescriptor, [...this.scopePath]),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            this.outputAddedHandlers.push(handler);
            return;
        }

        if (this.isBelowOutputPath(pathSegments)) {
            const translatedPath = this.translateOutputPathToChildPath(pathSegments);
            this.input.onAdded(translatedPath, (keyPath, key, immutableProps) => {
                const rewrittenKeyPath = this.rewriteNestedKeyPath(keyPath);
                if (rewrittenKeyPath !== null) {
                    handler(rewrittenKeyPath, key, immutableProps);
                }
            });
            return;
        }

        this.input.onAdded(pathSegments, handler);
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            this.outputRemovedHandlers.push(handler);
            return;
        }

        if (this.isBelowOutputPath(pathSegments)) {
            const translatedPath = this.translateOutputPathToChildPath(pathSegments);
            this.input.onRemoved(translatedPath, (keyPath, key, immutableProps) => {
                const rewrittenKeyPath = this.rewriteNestedKeyPath(keyPath);
                if (rewrittenKeyPath !== null) {
                    handler(rewrittenKeyPath, key, immutableProps);
                }
            });
            return;
        }

        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (pathsMatch(pathSegments, this.outputPath)) {
            const handlers = this.outputModifiedHandlersByProperty.get(propertyName) ?? [];
            handlers.push(handler);
            this.outputModifiedHandlersByProperty.set(propertyName, handlers);
            return;
        }

        if (this.isBelowOutputPath(pathSegments)) {
            const translatedPath = this.translateOutputPathToChildPath(pathSegments);
            this.input.onModified(translatedPath, propertyName, (keyPath, key, oldValue, newValue) => {
                const rewrittenKeyPath = this.rewriteNestedKeyPath(keyPath);
                if (rewrittenKeyPath !== null) {
                    handler(rewrittenKeyPath, key, oldValue, newValue);
                }
            });
            return;
        }

        this.input.onModified(pathSegments, propertyName, handler);
    }

    private assertValidConfiguration(descriptor: TypeDescriptor): void {
        const scopeNode = this.navigateToScopeNode(descriptor, [...this.scopePath]);
        if (scopeNode === null) {
            throw new Error(`flatten scope path is invalid: [${this.scopePath.join('.')}]`);
        }

        const parentArray = scopeNode.arrays.find(arrayDescriptor => arrayDescriptor.name === this.parentArrayName);
        if (!parentArray) {
            throw new Error(`flatten parent array not found at current scope: "${this.parentArrayName}"`);
        }

        const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === this.childArrayName);
        if (!childArray) {
            throw new Error(`flatten child array not found within parent array "${this.parentArrayName}": "${this.childArrayName}"`);
        }

        if (scopeNode.arrays.some(arrayDescriptor => arrayDescriptor.name === this.outputArrayName)) {
            throw new Error(`flatten output array already exists at current scope: "${this.outputArrayName}"`);
        }
    }

    private getChildScalarNames(descriptor: TypeDescriptor): Set<string> {
        const scopeNode = this.navigateToScopeNode(descriptor, [...this.scopePath]);
        if (!scopeNode) {
            return new Set<string>();
        }

        const parentArray = scopeNode.arrays.find(arrayDescriptor => arrayDescriptor.name === this.parentArrayName);
        if (!parentArray) {
            return new Set<string>();
        }

        const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === this.childArrayName);
        if (!childArray) {
            return new Set<string>();
        }

        return new Set(childArray.type.scalars.map(scalar => scalar.name));
    }

    private navigateToScopeNode(node: DescriptorNode, remainingSegments: string[]): DescriptorNode | null {
        if (remainingSegments.length === 0) {
            return node;
        }

        const [segment, ...rest] = remainingSegments;
        const arrayDescriptor = node.arrays.find(array => array.name === segment);
        if (!arrayDescriptor) {
            return null;
        }
        return this.navigateToScopeNode(arrayDescriptor.type, rest);
    }

    private transformDescriptorAtScope(node: DescriptorNode, remainingScopePath: string[]): DescriptorNode {
        if (remainingScopePath.length === 0) {
            const parentArray = node.arrays.find(arrayDescriptor => arrayDescriptor.name === this.parentArrayName);
            if (!parentArray) {
                return node;
            }
            const childArray = parentArray.type.arrays.find(arrayDescriptor => arrayDescriptor.name === this.childArrayName);
            if (!childArray) {
                return node;
            }

            const mergedScalars = mergeScalarsWithChildPrecedence(parentArray.type.scalars, childArray.type.scalars);
            const flattenedNode: DescriptorNode = {
                arrays: childArray.type.arrays,
                collectionKey: [...parentArray.type.collectionKey, ...childArray.type.collectionKey],
                scalars: mergedScalars,
                objects: mergeObjectsWithChildPrecedence(parentArray.type.objects, childArray.type.objects),
                mutableProperties: mergedMutableProperties(
                    parentArray.type.mutableProperties,
                    childArray.type.mutableProperties,
                    mergedScalars
                )
            };

            const arrays = node.arrays.map(arrayDescriptor => {
                if (arrayDescriptor.name === this.parentArrayName) {
                    return {
                        name: this.outputArrayName,
                        type: flattenedNode
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
                    type: this.transformDescriptorAtScope(arrayDescriptor.type, rest)
                };
            })
        };
    }

    private isBelowOutputPath(pathSegments: string[]): boolean {
        return pathSegments.length > this.outputPath.length && pathStartsWith(pathSegments, this.outputPath);
    }

    private translateOutputPathToChildPath(pathSegments: string[]): string[] {
        const suffix = pathSegments.slice(this.outputPath.length);
        return [...this.childPath, ...suffix];
    }

    private rewriteNestedKeyPath(keyPath: string[]): string[] | null {
        if (keyPath.length <= this.outputDepth + 1) {
            return null;
        }

        const outputKeyPath = keyPath.slice(0, this.outputDepth);
        const parentKey = keyPath[this.outputDepth];
        const childKey = keyPath[this.outputDepth + 1];
        if (parentKey === undefined || childKey === undefined) {
            return null;
        }

        const suffix = keyPath.slice(this.outputDepth + 2);
        const flatKey = compositeChildKey(parentKey, childKey);
        return [...outputKeyPath, flatKey, ...suffix];
    }

    private handleParentAdded(keyPath: string[], parentKey: string, immutableProps: ImmutableProps): void {
        const id = parentIdentity(keyPath, parentKey);
        this.parentScalarsByParentIdentity.set(id, immutableProps);
        if (!this.childKeysByParentIdentity.has(id)) {
            this.childKeysByParentIdentity.set(id, new Set<string>());
        }
    }

    private handleParentRemoved(keyPath: string[], parentKey: string): void {
        const id = parentIdentity(keyPath, parentKey);
        this.parentScalarsByParentIdentity.delete(id);
        this.childKeysByParentIdentity.delete(id);
        this.childPropertyCountsByParentIdentity.delete(id);
    }

    private handleChildAdded(keyPath: string[], childKey: string, childProps: ImmutableProps): void {
        if (keyPath.length <= this.outputDepth) {
            return;
        }

        const outputKeyPath = keyPath.slice(0, this.outputDepth);
        const parentKey = keyPath[this.outputDepth];
        if (parentKey === undefined) {
            return;
        }
        const id = parentIdentity(outputKeyPath, parentKey);
        const parentProps = this.parentScalarsByParentIdentity.get(id) ?? {};

        let childKeys = this.childKeysByParentIdentity.get(id);
        if (!childKeys) {
            childKeys = new Set<string>();
            this.childKeysByParentIdentity.set(id, childKeys);
        }
        childKeys.add(childKey);

        let propertyCounts = this.childPropertyCountsByParentIdentity.get(id);
        if (!propertyCounts) {
            propertyCounts = new Map<string, number>();
            this.childPropertyCountsByParentIdentity.set(id, propertyCounts);
        }
        for (const propertyName of Object.keys(childProps)) {
            propertyCounts.set(propertyName, (propertyCounts.get(propertyName) ?? 0) + 1);
        }

        const flatKey = compositeChildKey(parentKey, childKey);
        const mergedProps = { ...parentProps, ...childProps };
        this.outputAddedHandlers.forEach(handler => {
            handler(outputKeyPath, flatKey, mergedProps);
        });
    }

    private handleChildRemoved(keyPath: string[], childKey: string, childProps: ImmutableProps): void {
        if (keyPath.length <= this.outputDepth) {
            return;
        }

        const outputKeyPath = keyPath.slice(0, this.outputDepth);
        const parentKey = keyPath[this.outputDepth];
        if (parentKey === undefined) {
            return;
        }
        const id = parentIdentity(outputKeyPath, parentKey);
        const parentProps = this.parentScalarsByParentIdentity.get(id) ?? {};

        const childKeys = this.childKeysByParentIdentity.get(id);
        childKeys?.delete(childKey);
        const propertyCounts = this.childPropertyCountsByParentIdentity.get(id);
        if (propertyCounts) {
            for (const propertyName of Object.keys(childProps)) {
                const count = propertyCounts.get(propertyName);
                if (!count) {
                    continue;
                }
                if (count <= 1) {
                    propertyCounts.delete(propertyName);
                } else {
                    propertyCounts.set(propertyName, count - 1);
                }
            }
            if (propertyCounts.size === 0) {
                this.childPropertyCountsByParentIdentity.delete(id);
            }
        }

        const flatKey = compositeChildKey(parentKey, childKey);
        const mergedProps = { ...parentProps, ...childProps };
        this.outputRemovedHandlers.forEach(handler => {
            handler(outputKeyPath, flatKey, mergedProps);
        });
    }

    private handleParentModified(
        keyPath: string[],
        parentKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        const id = parentIdentity(keyPath, parentKey);
        // Child scalar values win on collision. Parent modifications for colliding names
        // should not fan out to flattened children.
        if (this.childScalarNames.has(propertyName) || this.parentHasChildProperty(id, propertyName)) {
            return;
        }
        const parentProps = this.parentScalarsByParentIdentity.get(id);
        if (parentProps) {
            this.parentScalarsByParentIdentity.set(id, {
                ...parentProps,
                [propertyName]: newValue
            });
        }

        const childKeys = this.childKeysByParentIdentity.get(id);
        if (!childKeys || childKeys.size === 0) {
            return;
        }

        const handlers = this.outputModifiedHandlersByProperty.get(propertyName);
        if (!handlers || handlers.length === 0) {
            return;
        }

        childKeys.forEach(childKey => {
            const flatKey = compositeChildKey(parentKey, childKey);
            handlers.forEach(handler => {
                handler(keyPath, flatKey, oldValue, newValue);
            });
        });
    }

    private parentHasChildProperty(parentId: string, propertyName: string): boolean {
        const propertyCounts = this.childPropertyCountsByParentIdentity.get(parentId);
        if (!propertyCounts) {
            return false;
        }
        return (propertyCounts.get(propertyName) ?? 0) > 0;
    }

    private handleChildModified(
        keyPath: string[],
        childKey: string,
        propertyName: string,
        oldValue: unknown,
        newValue: unknown
    ): void {
        if (keyPath.length <= this.outputDepth) {
            return;
        }

        const handlers = this.outputModifiedHandlersByProperty.get(propertyName);
        if (!handlers || handlers.length === 0) {
            return;
        }

        const outputKeyPath = keyPath.slice(0, this.outputDepth);
        const parentKey = keyPath[this.outputDepth];
        if (parentKey === undefined) {
            return;
        }

        const flatKey = compositeChildKey(parentKey, childKey);
        handlers.forEach(handler => {
            handler(outputKeyPath, flatKey, oldValue, newValue);
        });
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
        return getDescriptorFromFactory(
            this.upstream.getTypeDescriptor(),
            input => new FlattenStep(input, this.parentPath, this.childPath, this.outputPath)
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new FlattenStep(up.lastStep, this.parentPath, this.childPath, this.outputPath)
        };
    }
}
