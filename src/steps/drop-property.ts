import type { AddedHandler, ModifiedHandler, RemovedHandler, Step } from '../pipeline.js';
import { type DescriptorNode, type TypeDescriptor } from '../pipeline.js';
import { pathsMatch } from '../util/path.js';

export class DropPropertyStep<T, K extends keyof T> implements Step {
    private isArrayProperty: boolean;
    private fullSegmentPath: string[];
    
    constructor(
        private input: Step,
        private propertyName: K,
        private scopeSegments: string[]
    ) {
        // Check if the property is an array in the type descriptor
        const descriptor = this.input.getTypeDescriptor();
        this.fullSegmentPath = [...this.scopeSegments, this.propertyName as string];
        this.isArrayProperty = this.isArrayInDescriptor(descriptor, this.scopeSegments, this.propertyName as string);
    }
    
    /**
     * Checks if a property name exists as an array in the type descriptor at the given path segments.
     */
    private isArrayInDescriptor(
        descriptor: TypeDescriptor,
        segmentPath: string[],
        propertyName: string
    ): boolean {
        // Navigate to the scope segments
        const targetDescriptor = this.navigateToPath(descriptor, segmentPath);
        
        // Check if propertyName exists in the arrays at this level
        return targetDescriptor.arrays.some(array => array.name === propertyName);
    }
    
    /**
     * Navigates through the type descriptor to reach the target path segments.
     */
    private navigateToPath(descriptor: DescriptorNode, segmentPath: string[]): DescriptorNode {
        if (segmentPath.length === 0) {
            return descriptor;
        }
        
        const [currentSegment, ...remainingSegments] = segmentPath;
        const arrayDesc = descriptor.arrays.find(a => a.name === currentSegment);
        
        if (!arrayDesc) {
            // Path segments don't exist - return empty descriptor
            return { arrays: [], collectionKey: [], scalars: [] };
        }
        
        return this.navigateToPath(arrayDesc.type, remainingSegments);
    }
    
    getTypeDescriptor(): TypeDescriptor {
        const inputDescriptor = this.input.getTypeDescriptor();
        if (this.isArrayProperty) {
            // Remove the array from the descriptor
            return {
                ...this.transformDescriptor(inputDescriptor, [...this.fullSegmentPath]),
                rootCollectionName: inputDescriptor.rootCollectionName
            };
        }
        return {
            ...this.transformDescriptorForScalarDrop(inputDescriptor, [...this.scopeSegments], this.propertyName as string),
            rootCollectionName: inputDescriptor.rootCollectionName
        };
    }
    
    /**
     * Recursively transforms the type descriptor to remove the target array.
     * (Same logic as DropArrayStep)
     */
    private transformDescriptor(
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
            // This is the target array - remove it from the descriptor
            return {
                ...descriptor,
                arrays: descriptor.arrays.filter(a => a.name !== currentSegment),
            };
        }
        
        // Navigate deeper into the tree
        return {
            ...descriptor,
            arrays: descriptor.arrays.map(arrayDesc => {
                if (arrayDesc.name === currentSegment) {
                    return {
                        name: arrayDesc.name,
                        type: this.transformDescriptor(arrayDesc.type, remainingSegmentsAfter)
                    };
                }
                return arrayDesc;
            }),
        };
    }

    private transformDescriptorForScalarDrop(
        descriptor: DescriptorNode,
        remainingScopeSegments: string[],
        droppedPropertyName: string
    ): DescriptorNode {
        if (remainingScopeSegments.length === 0) {
            const nextCollectionKey = descriptor.collectionKey.includes(droppedPropertyName)
                ? []
                : descriptor.collectionKey;
            // Filter out the dropped scalar
            const filteredScalars = descriptor.scalars.filter(s => s.name !== droppedPropertyName);
            return {
                ...descriptor,
                collectionKey: nextCollectionKey,
                scalars: filteredScalars
            };
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
                    type: this.transformDescriptorForScalarDrop(
                        arrayDesc.type,
                        remainingSegmentsAfter,
                        droppedPropertyName
                    )
                };
            })
        };
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
                    handler(keyPath, key, rest as Omit<T, K>);
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

