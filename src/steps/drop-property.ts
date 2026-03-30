import type {
    AddedHandler,
    BuildContext,
    BuiltStepGraph,
    ImmutableProps,
    ModifiedHandler,
    RemovedHandler,
    Step,
    StepBuilder,
    TypeDescriptor
} from '../pipeline.js';
import { type DescriptorNode } from '../pipeline.js';
import { pathsMatch } from '../util/path.js';
import { emptyDescriptorNode, filterMetadataByPropertyName } from '../util/descriptor-transform.js';

function navigateDescriptorPath(descriptor: DescriptorNode, segmentPath: string[]): DescriptorNode {
    if (segmentPath.length === 0) {
        return descriptor;
    }

    const [currentSegment, ...remainingSegments] = segmentPath;
    const arrayDesc = descriptor.arrays.find(a => a.name === currentSegment);
    if (!arrayDesc) {
        return emptyDescriptorNode();
    }

    return navigateDescriptorPath(arrayDesc.type, remainingSegments);
}

function isArrayInDescriptor(
    descriptor: TypeDescriptor,
    segmentPath: string[],
    propertyName: string
): boolean {
    const targetDescriptor = navigateDescriptorPath(descriptor, segmentPath);
    return targetDescriptor.arrays.some(array => array.name === propertyName);
}

function transformDescriptorRemovingArray(
    descriptor: DescriptorNode,
    remainingSegments: string[]
): DescriptorNode {
    if (remainingSegments.length === 0) {
        return {
            ...descriptor,
            collectionKey: descriptor.collectionKey,
            mutableProperties: descriptor.mutableProperties
        };
    }

    const [currentSegment, ...remainingSegmentsAfter] = remainingSegments;
    if (remainingSegmentsAfter.length === 0) {
        return {
            ...descriptor,
            arrays: descriptor.arrays.filter(a => a.name !== currentSegment),
        };
    }

    return {
        ...descriptor,
        arrays: descriptor.arrays.map(arrayDesc => {
            if (arrayDesc.name === currentSegment) {
                return {
                    name: arrayDesc.name,
                    type: transformDescriptorRemovingArray(arrayDesc.type, remainingSegmentsAfter)
                };
            }
            return arrayDesc;
        }),
    };
}

function transformDescriptorRemovingScalar(
    descriptor: DescriptorNode,
    remainingScopeSegments: string[],
    droppedPropertyName: string
): DescriptorNode {
    if (remainingScopeSegments.length === 0) {
        const nextCollectionKey = descriptor.collectionKey.includes(droppedPropertyName)
            ? []
            : descriptor.collectionKey;
        const filteredScalars = descriptor.scalars.filter(s => s.name !== droppedPropertyName);
        return filterMetadataByPropertyName(
            {
                ...descriptor,
                collectionKey: nextCollectionKey,
                scalars: filteredScalars
            },
            droppedPropertyName
        );
    }

    const [currentSegment, ...remainingSegmentsAfter] = remainingScopeSegments;
    return {
        ...descriptor,
        arrays: descriptor.arrays.map(arrayDesc => {
            if (arrayDesc.name !== currentSegment) {
                return arrayDesc;
            }

            return {
                ...arrayDesc,
                type: transformDescriptorRemovingScalar(
                    arrayDesc.type,
                    remainingSegmentsAfter,
                    droppedPropertyName
                )
            };
        })
    };
}

function transformDropPropertyDescriptor(
    inputDescriptor: TypeDescriptor,
    propertyName: string,
    scopeSegments: string[]
): TypeDescriptor {
    const fullSegmentPath = [...scopeSegments, propertyName];
    const arrayProperty = isArrayInDescriptor(inputDescriptor, scopeSegments, propertyName);
    if (arrayProperty) {
        return {
            ...transformDescriptorRemovingArray(inputDescriptor, [...fullSegmentPath]),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }
    const scalarTransformed = transformDescriptorRemovingScalar(
        inputDescriptor,
        [...scopeSegments],
        propertyName
    );
    return {
        ...scalarTransformed,
        rootCollectionName: inputDescriptor.rootCollectionName
    };
}

/**
 * Drops a scalar or array property from the stream at the given scope.
 * Property names are validated by the fluent {@link PipelineBuilder} API; at runtime
 * rows are {@link ImmutableProps} and this step filters by descriptor-driven behavior.
 */
export class DropPropertyStep implements Step {
    private isArrayProperty: boolean;
    private fullSegmentPath: string[];

    constructor(
        private input: Step,
        private propertyName: string,
        private scopeSegments: string[],
        inputDescriptor: TypeDescriptor
    ) {
        // Check if the property is an array in the type descriptor
        this.fullSegmentPath = [...this.scopeSegments, this.propertyName];
        this.isArrayProperty = isArrayInDescriptor(inputDescriptor, this.scopeSegments, this.propertyName);
    }
    
    onAdded(pathSegments: string[], handler: AddedHandler): void {
        if (this.isArrayProperty) {
            // Array behavior: suppress events at or below the array path segments
            if (this.isAtOrBelowTargetArray(pathSegments)) {
                return;
            }
            this.input.onAdded(pathSegments, handler);
        } else {
            // Property behavior: filter the property from immutableProps
            if (this.isAtScopeSegments(pathSegments)) {
                this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                    const { [this.propertyName]: _, ...rest } = immutableProps;
                    handler(keyPath, key, rest as ImmutableProps);
                });
            } else {
                this.input.onAdded(pathSegments, handler);
            }
        }
    }
    
    onRemoved(pathSegments: string[], handler: RemovedHandler): void {
        if (this.isArrayProperty) {
            // Array behavior: suppress events at or below the array path segments
            if (this.isAtOrBelowTargetArray(pathSegments)) {
                return;
            }
        }
        this.input.onRemoved(pathSegments, handler);
    }

    onModified(pathSegments: string[], propertyName: string, handler: ModifiedHandler): void {
        if (this.isArrayProperty) {
            // Array behavior: suppress events at or below the array path segments
            if (this.isAtOrBelowTargetArray(pathSegments)) {
                return;
            }
        }
        this.input.onModified(pathSegments, propertyName, handler);
    }
    
    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
    
    /**
     * Checks if path segments are at or below the target array.
     */
    private isAtOrBelowTargetArray(pathSegments: string[]): boolean {
        if (pathSegments.length < this.fullSegmentPath.length) {
            return false;
        }
        return this.fullSegmentPath.every((segment, i) => pathSegments[i] === segment);
    }
}

export class DropPropertyBuilder implements StepBuilder {
    constructor(
        readonly upstream: StepBuilder,
        private propertyName: string,
        private scopeSegments: string[]
    ) {}

    getTypeDescriptor(): TypeDescriptor {
        return transformDropPropertyDescriptor(
            this.upstream.getTypeDescriptor(),
            this.propertyName,
            this.scopeSegments
        );
    }

    buildGraph(ctx: BuildContext): BuiltStepGraph {
        const up = this.upstream.buildGraph(ctx);
        return {
            ...up,
            lastStep: new DropPropertyStep(
                up.lastStep,
                this.propertyName,
                this.scopeSegments,
                this.upstream.getTypeDescriptor()
            )
        };
    }
}

