import type { AddedHandler, ModifiedHandler, RemovedHandler, Step } from '../pipeline';
import { type TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

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
    private navigateToPath(descriptor: TypeDescriptor, segmentPath: string[]): TypeDescriptor {
        if (segmentPath.length === 0) {
            return descriptor;
        }
        
        const [currentSegment, ...remainingSegments] = segmentPath;
        const arrayDesc = descriptor.arrays.find(a => a.name === currentSegment);
        
        if (!arrayDesc) {
            // Path segments don't exist - return empty descriptor
            return { arrays: [] };
        }
        
        return this.navigateToPath(arrayDesc.type, remainingSegments);
    }
    
    getTypeDescriptor(): TypeDescriptor {
        if (this.isArrayProperty) {
            // Remove the array from the descriptor
            const inputDescriptor = this.input.getTypeDescriptor();
            return this.transformDescriptor(inputDescriptor, [...this.fullSegmentPath]);
        }
        // For non-array properties, don't modify the descriptor
        return this.input.getTypeDescriptor();
    }
    
    /**
     * Recursively transforms the type descriptor to remove the target array.
     * (Same logic as DropArrayStep)
     */
    private transformDescriptor(
        descriptor: TypeDescriptor, 
        remainingSegments: string[]
    ): TypeDescriptor {
        if (remainingSegments.length === 0) {
            return descriptor;
        }
        
        const [currentSegment, ...remainingSegmentsAfter] = remainingSegments;
        
        if (remainingSegmentsAfter.length === 0) {
            // This is the target array - remove it from the descriptor
            return {
                arrays: descriptor.arrays.filter(a => a.name !== currentSegment)
            };
        }
        
        // Navigate deeper into the tree
        return {
            arrays: descriptor.arrays.map(arrayDesc => {
                if (arrayDesc.name === currentSegment) {
                    return {
                        name: arrayDesc.name,
                        type: this.transformDescriptor(arrayDesc.type, remainingSegmentsAfter)
                    };
                }
                return arrayDesc;
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

    onModified(pathSegments: string[], handler: ModifiedHandler): void {
        if (this.isArrayProperty) {
            // Array behavior: suppress events at or below the array path segments
            if (this.isAtOrBelowTargetArray(pathSegments)) {
                return;
            }
        }
        this.input.onModified(pathSegments, handler);
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

