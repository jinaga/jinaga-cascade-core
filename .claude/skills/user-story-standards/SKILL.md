---
name: user-story-standards
description: Format and standards for writing user stories in the Cascade project. Use when creating, reviewing, or modifying user stories in docs/user-stories/. Documents the structure, acceptance criteria format, and opinions about detail level and complexity progression.
---

# User Story Standards

This skill documents the format and standards for user stories in the Cascade project. User stories are located in `docs/user-stories/` and serve as detailed specifications for features.

## Standard Format

User stories follow this structure:

### 1. Title
```markdown
# User Story: [Descriptive Name]
```

### 2. Story Section (Standard User Story Format)
```markdown
## Story
**As a** [user type]
**I want to** [action/goal]
**So that** [benefit/value]
```

### 3. Description
A narrative explanation of the feature, including:
- Context and user flow overview
- Configuration flows (if applicable)
- Design decisions (when relevant)

### 4. Acceptance Criteria
Numbered as `AC1`, `AC2`, etc., using **Given/When/Then** format:
- **Given** [precondition]
- **When** [action]
- **Then** [expected outcome]
- **And** [additional conditions]

Acceptance criteria may be grouped by feature area (e.g., "Sum Step Configuration", "Validation", "Cancellation").

### 5. Additional Sections (when applicable)
- **Design Decisions**: Rationale for UI/UX choices
- **User Flows**: Step-by-step interaction flows
- **Visual Styling**: Design specifications
- **Cancellation**: How users can cancel operations

### 6. Technical Notes
**Domain-specific technical information only** - avoid implementation details:
- Data structure requirements and constraints
- Algorithm descriptions (e.g., grouping logic, sorting rules)
- Domain-specific validation rules
- Technical domain concepts (e.g., series grouping, coordinate extraction)
- Rendering requirements and specifications

**Do NOT include**:
- File paths or component names
- Function or method names
- Implementation patterns or code structure
- Specific library or framework details

Implementation details belong in the **Related Files** section, not Technical Notes. Technical Notes should focus on *what* needs to happen technically, not *how* it's implemented in code.

### 7. Related Files
File paths with brief descriptions, organized by:
- Component files
- Context files
- Utility files
- Type definitions

### 8. Related User Journeys (optional)
Links to broader user journey documentation and context within the overall workflow.

## Acceptance Criteria Philosophy

**Critical Principle**: Acceptance criteria should start simple and grow in complexity to handle significant edge cases, but should not be overly detailed.

### Structure Guidelines

1. **Start Simple**: Begin with the happy path and core functionality
   - AC1 typically covers the basic initial state or primary action
   - Early ACs establish the foundation of the feature

2. **Progressive Complexity**: Build up to handle important edge cases
   - After establishing basics, add ACs for variations (e.g., different input methods, nested structures)
   - Include validation and error handling
   - Cover accessibility and keyboard interactions
   - Address cancellation and state transitions

3. **Significant Edge Cases Only**: Focus on cases that matter
   - Include edge cases that affect user experience or data integrity
   - Skip trivial variations that don't add meaningful coverage
   - Avoid exhaustive enumeration of every possible scenario

4. **Avoid Over-Detail**: Keep ACs focused and testable
   - Each AC should be independently verifiable
   - Don't duplicate information already covered in Description or Technical Notes
   - Avoid implementation minutiae that belongs in Technical Notes
   - Don't specify every visual detail unless it's critical to the feature

### Examples of Good Progression

**Simple Start:**
- AC1: Basic feature appears when conditions are met
- AC2: Primary action works correctly

**Growing Complexity:**
- AC3-5: Alternative input methods (menu vs button, keyboard vs mouse)
- AC6-8: Edge cases (empty state, validation, cancellation)
- AC9-10: Visual feedback and accessibility

**Appropriate Detail Level:**
- ✅ "A button labeled 'Add Source' positioned below the message"
- ✅ "The button should be visually prominent and clearly clickable"
- ❌ "The button should be 48px tall, use font-size 16px, have padding of 12px 24px, border-radius of 4px, and use the secondary color from the theme palette"

## Characteristics of Good User Stories

- **Detailed but Focused**: Comprehensive coverage without unnecessary minutiae
- **Testable**: Each AC is independently verifiable
- **Technical Context**: Technical Notes provide domain-specific technical requirements; Related Files section connects to implementation
- **Cross-Referenced**: Links to related files and user journeys
- **Consistent Structure**: Same format across all stories

## When to Use This Skill

Use this skill when:
- Creating a new user story
- Reviewing or modifying existing user stories
- Ensuring consistency across user stories
- Deciding what level of detail to include in acceptance criteria
- Structuring acceptance criteria for progressive complexity
