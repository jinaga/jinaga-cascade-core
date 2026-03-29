# React Hooks Testing: Anti-Patterns to Avoid

## The Critical Mistake: Mocking Internal Hooks

### ❌ WRONG APPROACH - Testing Implementation

This anti-pattern is extremely common but fundamentally flawed:

```typescript
// ❌ BAD - Mocking your own hooks
vi.mock('../../hooks/useWindow', () => ({
  useWindow: vi.fn()
}));

vi.mock('../../contexts/AppNavigationContext', () => ({
  useAppNavigation: vi.fn()
}));

it('should call useWindow hook', () => {
  const { result } = renderHook(() => useMyCommand());
  
  // ❌ Tests HOW the code works, not WHAT it does
  expect(useWindow).toHaveBeenCalled();
  expect(useAppNavigation).toHaveBeenCalled();
});
```

**Why this is wrong:**
1. **Tests implementation details**: Breaks when you refactor how contexts are accessed
2. **Provides no value**: Doesn't verify any user-visible behavior
3. **Creates brittle tests**: Changes to internal structure break unrelated tests
4. **Loses type safety**: Mock functions don't follow the real interface
5. **Misses real bugs**: Passes even if your code doesn't actually work

### ✅ CORRECT APPROACH - Testing Behavior with Fakes

```typescript
// ✅ GOOD - Fake implementations with dependency injection

// Create test contexts
const TestWindowContext = createContext<WindowContextType | undefined>(undefined);
const TestAppNavigationContext = createContext<AppNavigationContextType | undefined>(undefined);

// Create fake implementations
class FakeWindowContext implements WindowContextType {
  workspace: WorkspaceDocument | null;
  updateWorkspaceCalls: WorkspaceDocument[] = [];
  
  constructor(workspace: WorkspaceDocument | null) {
    this.workspace = workspace;
  }
  
  async updateWorkspace(workspace: WorkspaceDocument): Promise<void> {
    this.updateWorkspaceCalls.push(workspace);
    this.workspace = workspace;
  }
  
  // ... other WindowContextType methods
}

// Create wrapper with fakes
function createTestWrapper(config?: { windowContext?: FakeWindowContext }) {
  const windowContext = config?.windowContext ?? new FakeWindowContext(givenWorkspace());
  
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TestWindowContext.Provider value={windowContext}>
        {children}
      </TestWindowContext.Provider>
    );
  };
}

// Redirect useWindow to use test context
vi.mock('../../hooks/useWindow', () => ({
  useWindow: () => {
    const context = React.useContext(TestWindowContext);
    if (!context) throw new Error('useWindow must be used within WindowProvider');
    return context;
  },
}));

it('should update workspace when command is called', async () => {
  // Given: Fake context that tracks behavior
  const fakeContext = new FakeWindowContext(givenWorkspace());
  const wrapper = createTestWrapper({ windowContext: fakeContext });
  
  // When: Call the command
  const { result } = renderHook(() => useMyCommand(), { wrapper });
  await act(() => result.current.myCommand('/data.csv'));
  
  // Then: Verify WHAT happened (observable behavior)
  expect(fakeContext.updateWorkspaceCalls).toHaveLength(1);
  expect(fakeContext.updateWorkspaceCalls[0].dataSources).toContainEqual({
    id: expect.stringMatching(/^ds-/),
    filePath: '/data.csv'
  });
});
```

**Why this is correct:**
1. **Tests observable behavior**: Verifies workspace was updated correctly
2. **Type-safe**: Fake implements full interface, catches breaking changes
3. **Refactor-safe**: Doesn't break when you reorganize code
4. **Realistic**: Tests closer to how production code will run
5. **Reusable**: Same fakes work across many tests

## The Pattern: Mock the Hook, Not the Context

When React contexts aren't exported (common pattern), you need a specific approach:

### Step 1: Create Test Contexts

```typescript
import { createContext } from 'react';
import type { WindowContextType } from '../../contexts/WindowContext';

const TestWindowContext = createContext<WindowContextType | undefined>(undefined);
```

### Step 2: Create Fake Implementations

```typescript
class FakeWindowContext implements WindowContextType {
  // Implement full interface
  // Include test helpers (e.g., call tracking)
}
```

### Step 3: Mock the Hook (not the context)

```typescript
vi.mock('../../hooks/useWindow', () => ({
  useWindow: () => {
    const context = React.useContext(TestWindowContext);
    if (!context) throw new Error('useWindow must be used within WindowProvider');
    return context;
  },
}));
```

This redirects `useWindow()` calls to use your test context, where you've injected fakes.

### Step 4: Create Wrapper Factory

```typescript
function createTestWrapper(config?: { windowContext?: FakeWindowContext }) {
  const windowContext = config?.windowContext ?? new FakeWindowContext();
  
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <TestWindowContext.Provider value={windowContext}>
        {children}
      </TestWindowContext.Provider>
    );
  };
}
```

### Step 5: Use in Tests

```typescript
it('should do something', async () => {
  const fakeContext = new FakeWindowContext();
  const wrapper = createTestWrapper({ windowContext: fakeContext });
  
  const { result } = renderHook(() => useMyHook(), { wrapper });
  await act(() => result.current.doSomething());
  
  // Assert on observable behavior
  expect(fakeContext.somethingCalls).toHaveLength(1);
});
```

## Common Objections Addressed

### "But mocking is easier!"

**Response**: Fakes are initially more work but pay dividends:
- Reusable across all tests for that dependency
- Catch interface changes at compile time
- Provide realistic behavior (state, async operations)
- Can be evolved to match production complexity

### "I'm just verifying the hook is called"

**Response**: That's testing implementation, not behavior. Ask:
- If I change how the context is accessed (directly vs via hook), should this test break?
- Am I verifying user-visible outcomes or internal details?

If your test doesn't verify observable behavior, it's worthless.

### "What if I need to mock because contexts aren't exported?"

**Response**: Use the pattern above:
1. Create test-local contexts
2. Mock the hooks to redirect to test contexts
3. Inject fakes via test context providers

This gives you realistic testing while working around architectural constraints.

## Summary

**Rule of thumb:** If you're using `vi.mock()` on a file path that starts with `./` or `../`, you're probably testing implementation details. Use fakes instead.

**Only mock:**
- Third-party APIs (`@tauri-apps/api`, browser APIs)
- External services you don't control

**Never mock:**
- Your own hooks
- Your own contexts
- Your own utilities
- Internal modules

Fakes test **WHAT** your code does. Mocks test **HOW** it does it. Always choose behavior over implementation.
