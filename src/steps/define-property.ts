import type { ImmutableProps, Step } from '../pipeline';
import { type TypeDescriptor } from '../pipeline';
import { pathsMatch } from '../util/path';

export class DefinePropertyStep<T, K extends string, U> implements Step {
    constructor(
        private input: Step,
        private propertyName: K,
        private compute: (item: T) => U,
        private scopeSegments: string[]
    ) {}
    
    getTypeDescriptor(): TypeDescriptor {
        return this.input.getTypeDescriptor();
    }
    
    onAdded(pathSegments: string[], handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Apply the property transformation at the scoped level
            this.input.onAdded(pathSegments, (keyPath, key, immutableProps) => {
                handler(keyPath, key, { ...immutableProps, [this.propertyName]: this.compute(immutableProps as T) } as T & Record<K, U>);
            });
        } else {
            // Pass through unchanged when not at scope segments
            this.input.onAdded(pathSegments, handler);
        }
    }
    
    onRemoved(pathSegments: string[], handler: (keyPath: string[], key: string, immutableProps: ImmutableProps) => void): void {
        if (this.isAtScopeSegments(pathSegments)) {
            // Apply the property transformation at the scoped level (for removal too)
            this.input.onRemoved(pathSegments, (keyPath, key, immutableProps) => {
                handler(keyPath, key, { ...immutableProps, [this.propertyName]: this.compute(immutableProps as T) } as T & Record<K, U>);
            });
        } else {
            // Pass through unchanged when not at scope segments
            this.input.onRemoved(pathSegments, handler);
        }
    }

    onModified(pathSegments: string[], handler: (keyPath: string[], key: string, name: string, value: any) => void): void {
        this.input.onModified(pathSegments, handler);
    }
    
    private isAtScopeSegments(pathSegments: string[]): boolean {
        return pathsMatch(pathSegments, this.scopeSegments);
    }
}

