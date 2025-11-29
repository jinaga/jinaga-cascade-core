/**
 * Checks if two path segment arrays match exactly.
 * 
 * @param pathSegments - The path segments to check
 * @param targetSegments - The target path segments to compare against
 * @returns true if the path segments match exactly
 */
export function pathsMatch(pathSegments: string[], targetSegments: string[]): boolean {
    if (pathSegments.length !== targetSegments.length) {
        return false;
    }
    return pathSegments.every((segment, i) => segment === targetSegments[i]);
}

/**
 * Checks if pathSegments starts with the given prefix path segments.
 * 
 * @param pathSegments - The path segments to check
 * @param prefixSegments - The prefix path segments to compare against
 * @returns true if pathSegments starts with prefixSegments
 */
export function pathStartsWith(pathSegments: string[], prefixSegments: string[]): boolean {
    if (pathSegments.length < prefixSegments.length) {
        return false;
    }
    return prefixSegments.every((segment, i) => segment === pathSegments[i]);
}