import { KeyedArray } from '../builder';

/**
 * Navigates through a type following a variadic path of array property names.
 * Returns the item type at the final path.
 * 
 * @example
 * type Input = {
 *   state: string;
 *   cities: KeyedArray<{
 *     city: string;
 *     venues: KeyedArray<{ name: string }>
 *   }>;
 * };
 * 
 * NavigateToPath<Input, ['cities']> = { city: string; venues: KeyedArray<{ name: string }> }
 * NavigateToPath<Input, ['cities', 'venues']> = { name: string }
 * NavigateToPath<Input, []> = Input
 */
export type NavigateToPath<T, Path extends string[]> =
    Path extends [infer First extends string, ...infer Rest extends string[]]
        ? First extends keyof T
            ? T[First] extends KeyedArray<infer ItemType>
                ? Rest extends []
                    ? ItemType
                    : NavigateToPath<ItemType, Rest>
                : never  // Property is not a KeyedArray
            : never  // Property doesn't exist
        : T;  // Empty path returns the original type

/**
 * Validates that a path is valid for a given type.
 * Returns the path if valid, never otherwise.
 * 
 * This type utility is used at compile-time to ensure path segments
 * reference valid KeyedArray properties in the type structure.
 * 
 * @example
 * type Input = {
 *   state: string;
 *   cities: KeyedArray<{
 *     city: string;
 *     venues: KeyedArray<{ name: string }>
 *   }>;
 * };
 * 
 * ValidatePath<Input, ['cities']> = ['cities']
 * ValidatePath<Input, ['cities', 'venues']> = ['cities', 'venues']
 * ValidatePath<Input, ['state']> = never  // 'state' is not a KeyedArray
 * ValidatePath<Input, ['invalid']> = never  // property doesn't exist
 * ValidatePath<Input, []> = []  // empty path is valid
 */
export type ValidatePath<T, Path extends string[]> =
    Path extends [infer First extends string, ...infer Rest extends string[]]
        ? First extends keyof T
            ? T[First] extends KeyedArray<infer ItemType>
                ? Rest extends []
                    ? Path
                    : Rest extends string[]
                        ? ValidatePath<ItemType, Rest> extends never
                            ? never
                            : Path
                        : never
                : never  // Property is not a KeyedArray
            : never  // Property doesn't exist
        : [];  // Empty path is valid

/**
 * Transforms the type at a specific path while preserving the parent structure.
 * Used when operations modify types at a nested level.
 * 
 * @template T - The root type
 * @template Path - The path to the transformation point
 * @template NewItemType - The new type to place at the path location
 * 
 * @example
 * type Input = {
 *   state: string;
 *   cities: KeyedArray<{
 *     city: string;
 *     venues: KeyedArray<{ name: string }>
 *   }>;
 * };
 * 
 * // Transform at ['cities'] - replace city items with new type
 * TransformAtPath<Input, ['cities'], { newProp: number }> = {
 *   state: string;
 *   cities: KeyedArray<{ newProp: number }>
 * }
 * 
 * // Transform at ['cities', 'venues'] - replace venue items with new type
 * TransformAtPath<Input, ['cities', 'venues'], { transformed: boolean }> = {
 *   state: string;
 *   cities: KeyedArray<{
 *     city: string;
 *     venues: KeyedArray<{ transformed: boolean }>
 *   }>
 * }
 * 
 * // Empty path - return the new type directly
 * TransformAtPath<Input, [], { completely: 'new' }> = { completely: 'new' }
 */
export type TransformAtPath<T, Path extends string[], NewItemType> =
    Path extends [infer First extends string, ...infer Rest extends string[]]
        ? First extends keyof T
            ? T[First] extends KeyedArray<infer ItemType>
                ? Rest extends []
                    // Replace the array item type
                    ? Omit<T, First> & { [K in First]: KeyedArray<NewItemType> }
                    // Recurse into nested structure
                    : Omit<T, First> & {
                        [K in First]: KeyedArray<TransformAtPath<ItemType, Extract<Rest, string[]>, NewItemType>>
                      }
                : never  // Property is not a KeyedArray
            : never  // Property doesn't exist
        : NewItemType;  // Empty path returns the new type