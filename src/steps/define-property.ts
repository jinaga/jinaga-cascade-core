import type { AddedHandler, BuildContext, BuiltStepGraph, DescriptorNode, ImmutableProps, ModifiedHandler, PlacedHandler, RemovedHandler, Step, StepBuilder, TypeDescriptor } from '../pipeline.js';
import { pathsMatch } from '../util/path.js';

function transformDefinePropertyDescriptor(
    inputDescriptor: TypeDescriptor,
    propertyName: string,
    scopeSegments: string[],
    mutableProperties: string[]
): TypeDescriptor {
    const appendDefinedScalarAtScope = (descriptor: TypeDescriptor): TypeDescriptor => {
        if (scopeSegments.length === 0) {
            if (descriptor.scalars.some(scalar => scalar.name === propertyName)) {
                return descriptor;
            }
            return {
                ...descriptor,
                scalars: [
                    ...descriptor.scalars,
                    { name: propertyName, type: 'unknown' as const }
                ]
            };
        }

        const appendScalarRecursively = (
            nodeDescriptor: DescriptorNode,
            remainingSegments: string[]
        ): DescriptorNode => {
            if (remainingSegments.length === 0) {
                if (nodeDescriptor.scalars.some(scalar => scalar.name === propertyName)) {
                    return nodeDescriptor;
                }
                return {
                    ...nodeDescriptor,
                    scalars: [
                        ...nodeDescriptor.scalars,
                        { name: propertyName, type: 'unknown' as const }
                    ]
                };
            }

            const [segment, ...tail] = remainingSegments;
            return {
                ...nodeDescriptor,
                arrays: nodeDescriptor.arrays.map(arrayDesc => {
                    if (arrayDesc.name !== segment) {
                        return arrayDesc;
                    }
                    return {
                        ...arrayDesc,
                        type: appendScalarRecursively(arrayDesc.type, tail)
                    };
                })
            };
        };

        const transformed = appendScalarRecursively(descriptor, scopeSegments);
        return {
            ...transformed,
            rootCollectionName: descriptor.rootCollectionName
        };
    };

    const withScalar = appendDefinedScalarAtScope(inputDescriptor);
    if (mutableProperties.length > 0) {
        const existingMutableProps = withScalar.mutableProperties;
        if (!existingMutableProps.includes(propertyName)) {
            return {
                ...withScalar,
                mutableProperties: [...existingMutableProps, propertyName]
            };
        }
    }
    return withScalar;
}

export class DefinePropertyStep<T, K extends string, U> implements Step {
    // Track items and their mutable property values + computed property value
    private itemStates: Map<string, {
        immutableProps: ImmutableProps;
        mutableValues: Map<string, unknown>;
        computedValue: U;
    }> = new Map();
    // Track handlers for onModified events on the defined property
    private modifiedHandlers: ModifiedHandler[] = [];

    constructor(
        private input: Step,
        private propertyName: K,
        private compute: (item: T) => U,
        private scopeSegments: string[],
        private mutableProperties: string[] = []
    ) {
        mutableProperties.forEach(propName => {
            this.input.onModified(this.scopeSegments, propName, (key, _oldValue, newValue) => {
                this.handleMutablePropertyChange(key, propName, newValue);
            });
        });
    }

    private composeItem(immutableProps: ImmutableProps, mutableValues: Map<string, unknown>): T {
        const mutableProps: Record<string, unknown> = {};
        for (const propName of this.mutableProperties) {
            mutableProps[propName] = mutableValues.get(propName);
        }
        return { ...immutableProps, ...mutableProps } as T;
    }

    private handleMutablePropertyChange(key: string, propertyName: string, newValue: unknown): void {
        const itemState = this.itemStates.get(key);
        if (!itemState) {
            return;
        }

        itemState.mutableValues.set(propertyName, newValue);

        const newComputedValue = this.compute(this.composeItem(itemState.immutableProps, itemState.mutableValues));
        const oldComputedValue = itemState.computedValue;
        itemState.computedValue = newComputedValue;

        if (oldComputedValue !== newComputedValue) {
            this.modifiedHandlers.forEach(handler => handler(key, oldComputedValue, newComputedValue));
        }
    }

    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onAdded(pathSegments, (parentKey, key, immutableProps) => {
                const mutableValues = new Map<string, unknown>();
                for (const propName of this.mutableProperties) {
                    mutableValues.set(propName, immutableProps[propName]);
                }
                const computedValue = this.compute(this.composeItem(immutableProps, mutableValues));
                this.itemStates.set(key, { immutableProps, mutableValues, computedValue });
                handler(parentKey, key, { ...immutableProps, [this.propertyName]: computedValue });
            });
        } else {
            this.input.onAdded(pathSegments, handler);
        }
    }

    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isAtScopeSegments(pathSegments)) {
            this.input.onRemoved(pathSegments, (key, immutableProps) => {
                const itemState = this.itemStates.get(key);
                const computedValue = itemState
                    ? this.compute(this.composeItem(immutableProps, itemState.mutableValues))
                    : this.compute(immutableProps as T);
                handler(key, { ...immutableProps, [this.propertyName]: computedValue });
                this.itemStates.delete(key);
            });
        } else {
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (propertyName === this.propertyName && this.isAtScopeSegments(pathSegments)) {
            this.modifiedHandlers.push(handler);
            return;
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }

    onPlaced(pathSegments: string[], handler: PlacedHandler): void {
        this.input.onPlaced(pathSegments, handler);
    }

    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}

export class DefinePropertyBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private propertyName: string,
        private compute: (item: unknown) => unknown,
        private scopeSegments: string[],
        private mutableProperties: string[]
    ) {
    }

    getTypeDescriptor(): TypeDescriptor {
        return transformDefinePropertyDescriptor(
            this.upstream.getTypeDescriptor(),
            this.propertyName,
            this.scopeSegments,
            this.mutableProperties
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new DefinePropertyStep(up.lastStep, this.propertyName, this.compute, this.scopeSegments, this.mutableProperties)
        };
    }
}

